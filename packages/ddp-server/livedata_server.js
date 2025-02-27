import isEmpty from 'lodash.isempty';
import isString from 'lodash.isstring';
import isObject from 'lodash.isobject';

DDPServer = {};


// Publication strategies define how we handle data from published cursors at the collection level
// This allows someone to:
// - Choose a trade-off between client-server bandwidth and server memory usage
// - Implement special (non-mongo) collections like volatile message queues
const publicationStrategies = {
  // SERVER_MERGE is the default strategy.
  // When using this strategy, the server maintains a copy of all data a connection is subscribed to.
  // This allows us to only send deltas over multiple publications.
  SERVER_MERGE: {
    useDummyDocumentView: false,
    useCollectionView: true,
    doAccountingForCollection: true,
  },
  // The NO_MERGE_NO_HISTORY strategy results in the server sending all publication data
  // directly to the client. It does not remember what it has previously sent
  // to it will not trigger removed messages when a subscription is stopped.
  // This should only be chosen for special use cases like send-and-forget queues.
  NO_MERGE_NO_HISTORY: {
    useDummyDocumentView: false,
    useCollectionView: false,
    doAccountingForCollection: false,
  },
  // NO_MERGE is similar to NO_MERGE_NO_HISTORY but the server will remember the IDs it has
  // sent to the client so it can remove them when a subscription is stopped.
  // This strategy can be used when a collection is only used in a single publication.
  NO_MERGE: {
    useDummyDocumentView: false,
    useCollectionView: false,
    doAccountingForCollection: true,
  },
  // NO_MERGE_MULTI is similar to `NO_MERGE`, but it does track whether a document is
  // used by multiple publications. This has some memory overhead, but it still does not do
  // diffing so it's faster and slimmer than SERVER_MERGE.
  NO_MERGE_MULTI: {
    useDummyDocumentView: true,
    useCollectionView: true,
    doAccountingForCollection: true
  }
};

DDPServer.publicationStrategies = publicationStrategies;

// This file contains classes:
// * Session - The server's connection to a single DDP client
// * Subscription - A single subscription for a single client
// * Server - An entire server that may talk to > 1 client. A DDP endpoint.
//
// Session and Subscription are file scope. For now, until we freeze
// the interface, Server is package scope (in the future it should be
// exported).
var DummyDocumentView = function () {
  var self = this;
  self.existsIn = new Set(); // set of subscriptionHandle
  self.dataByKey = new Map(); // key-> [ {subscriptionHandle, value} by precedence]
};

Object.assign(DummyDocumentView.prototype, {
  getFields: function () {
    return {}
  },

  clearField: function (subscriptionHandle, key, changeCollector) {
    changeCollector[key] = undefined
  },

  changeField: function (subscriptionHandle, key, value,
                         changeCollector, isAdd) {
    changeCollector[key] = value
  }
});

// Represents a single document in a SessionCollectionView
var SessionDocumentView = function () {
  var self = this;
  self.existsIn = new Set(); // set of subscriptionHandle
  self.dataByKey = new Map(); // key-> [ {subscriptionHandle, value} by precedence]
};

DDPServer._SessionDocumentView = SessionDocumentView;

DDPServer._getCurrentFence = function () {
  let currentInvocation = this._CurrentWriteFence.get();
  if (currentInvocation) {
    return currentInvocation;
  }
  currentInvocation = DDP._CurrentMethodInvocation.get();
  return currentInvocation ? currentInvocation.fence : undefined;
};

Object.assign(SessionDocumentView.prototype, {

  getFields: function () {
    var self = this;
    var ret = {};
    self.dataByKey.forEach(function (precedenceList, key) {
      ret[key] = precedenceList[0].value;
    });
    return ret;
  },

  clearField: function (subscriptionHandle, key, changeCollector) {
    var self = this;
    // Publish API ignores _id if present in fields
    if (key === "_id")
      return;
    var precedenceList = self.dataByKey.get(key);

    // It's okay to clear fields that didn't exist. No need to throw
    // an error.
    if (!precedenceList)
      return;

    var removedValue = undefined;
    for (var i = 0; i < precedenceList.length; i++) {
      var precedence = precedenceList[i];
      if (precedence.subscriptionHandle === subscriptionHandle) {
        // The view's value can only change if this subscription is the one that
        // used to have precedence.
        if (i === 0)
          removedValue = precedence.value;
        precedenceList.splice(i, 1);
        break;
      }
    }
    if (precedenceList.length === 0) {
      self.dataByKey.delete(key);
      changeCollector[key] = undefined;
    } else if (removedValue !== undefined &&
               !EJSON.equals(removedValue, precedenceList[0].value)) {
      changeCollector[key] = precedenceList[0].value;
    }
  },

  changeField: function (subscriptionHandle, key, value,
                         changeCollector, isAdd) {
    var self = this;
    // Publish API ignores _id if present in fields
    if (key === "_id")
      return;

    // Don't share state with the data passed in by the user.
    value = EJSON.clone(value);

    if (!self.dataByKey.has(key)) {
      self.dataByKey.set(key, [{subscriptionHandle: subscriptionHandle,
                                value: value}]);
      changeCollector[key] = value;
      return;
    }
    var precedenceList = self.dataByKey.get(key);
    var elt;
    if (!isAdd) {
      elt = precedenceList.find(function (precedence) {
          return precedence.subscriptionHandle === subscriptionHandle;
      });
    }

    if (elt) {
      if (elt === precedenceList[0] && !EJSON.equals(value, elt.value)) {
        // this subscription is changing the value of this field.
        changeCollector[key] = value;
      }
      elt.value = value;
    } else {
      // this subscription is newly caring about this field
      precedenceList.push({subscriptionHandle: subscriptionHandle, value: value});
    }

  }
});

/**
 * Represents a client's view of a single collection
 * @param {String} collectionName Name of the collection it represents
 * @param {Object.<String, Function>} sessionCallbacks The callbacks for added, changed, removed
 * @class SessionCollectionView
 */
var SessionCollectionView = function (collectionName, sessionCallbacks) {
  var self = this;
  self.collectionName = collectionName;
  self.documents = new Map();
  self.callbacks = sessionCallbacks;
};

DDPServer._SessionCollectionView = SessionCollectionView;


Object.assign(SessionCollectionView.prototype, {

  isEmpty: function () {
    var self = this;
    return self.documents.size === 0;
  },

  diff: function (previous) {
    var self = this;
    DiffSequence.diffMaps(previous.documents, self.documents, {
      both: self.diffDocument.bind(self),

      rightOnly: function (id, nowDV) {
        self.callbacks.added(self.collectionName, id, nowDV.getFields());
      },

      leftOnly: function (id, prevDV) {
        self.callbacks.removed(self.collectionName, id);
      }
    });
  },

  diffDocument: function (id, prevDV, nowDV) {
    var self = this;
    var fields = {};
    DiffSequence.diffObjects(prevDV.getFields(), nowDV.getFields(), {
      both: function (key, prev, now) {
        if (!EJSON.equals(prev, now))
          fields[key] = now;
      },
      rightOnly: function (key, now) {
        fields[key] = now;
      },
      leftOnly: function(key, prev) {
        fields[key] = undefined;
      }
    });
    self.callbacks.changed(self.collectionName, id, fields);
  },

  added: function (subscriptionHandle, id, fields) {
    var self = this;
    var docView = self.documents.get(id);
    var added = false;
    if (!docView) {
      added = true;
      if (Meteor.server.getPublicationStrategy(this.collectionName).useDummyDocumentView) {
        docView = new DummyDocumentView();
      } else {
        docView = new SessionDocumentView();
      }

      self.documents.set(id, docView);
    }
    docView.existsIn.add(subscriptionHandle);
    var changeCollector = {};
    Object.entries(fields).forEach(function ([key, value]) {
      docView.changeField(
        subscriptionHandle, key, value, changeCollector, true);
    });
    if (added)
      self.callbacks.added(self.collectionName, id, changeCollector);
    else
      self.callbacks.changed(self.collectionName, id, changeCollector);
  },

  changed: function (subscriptionHandle, id, changed) {
    var self = this;
    var changedResult = {};
    var docView = self.documents.get(id);
    if (!docView)
      throw new Error("Could not find element with id " + id + " to change");
      Object.entries(changed).forEach(function ([key, value]) {
      if (value === undefined)
        docView.clearField(subscriptionHandle, key, changedResult);
      else
        docView.changeField(subscriptionHandle, key, value, changedResult);
    });
    self.callbacks.changed(self.collectionName, id, changedResult);
  },

  removed: function (subscriptionHandle, id) {
    var self = this;
    var docView = self.documents.get(id);
    if (!docView) {
      var err = new Error("Removed nonexistent document " + id);
      throw err;
    }
    docView.existsIn.delete(subscriptionHandle);
    if (docView.existsIn.size === 0) {
      // it is gone from everyone
      self.callbacks.removed(self.collectionName, id);
      self.documents.delete(id);
    } else {
      var changed = {};
      // remove this subscription from every precedence list
      // and record the changes
      docView.dataByKey.forEach(function (precedenceList, key) {
        docView.clearField(subscriptionHandle, key, changed);
      });

      self.callbacks.changed(self.collectionName, id, changed);
    }
  }
});

/******************************************************************************/
/* Session                                                                    */
/******************************************************************************/

var Session = function (server, version, socket, options) {
  var self = this;
  self.id = Random.id();

  self.server = server;
  self.version = version;

  self.initialized = false;
  self.socket = socket;

  // Set to null when the session is destroyed. Multiple places below
  // use this to determine if the session is alive or not.
  self.inQueue = new Meteor._DoubleEndedQueue();

  self.blocked = false;
  self.workerRunning = false;

  self.cachedUnblock = null;

  // Sub objects for active subscriptions
  self._namedSubs = new Map();
  self._universalSubs = [];

  self.userId = null;

  self.collectionViews = new Map();

  // Set this to false to not send messages when collectionViews are
  // modified. This is done when rerunning subs in _setUserId and those messages
  // are calculated via a diff instead.
  self._isSending = true;

  // If this is true, don't start a newly-created universal publisher on this
  // session. The session will take care of starting it when appropriate.
  self._dontStartNewUniversalSubs = false;

  // When we are rerunning subscriptions, any ready messages
  // we want to buffer up for when we are done rerunning subscriptions
  self._pendingReady = [];

  // List of callbacks to call when this connection is closed.
  self._closeCallbacks = [];


  // XXX HACK: If a sockjs connection, save off the URL. This is
  // temporary and will go away in the near future.
  self._socketUrl = socket.url;

  // Allow tests to disable responding to pings.
  self._respondToPings = options.respondToPings;

  // This object is the public interface to the session. In the public
  // API, it is called the `connection` object.  Internally we call it
  // a `connectionHandle` to avoid ambiguity.
  self.connectionHandle = {
    id: self.id,
    close: function () {
      self.close();
    },
    onClose: function (fn) {
      var cb = Meteor.bindEnvironment(fn, "connection onClose callback");
      if (self.inQueue) {
        self._closeCallbacks.push(cb);
      } else {
        // if we're already closed, call the callback.
        Meteor.defer(cb);
      }
    },
    clientAddress: self._clientAddress(),
    httpHeaders: self.socket.headers
  };

  self.send({ msg: 'connected', session: self.id });

  // On initial connect, spin up all the universal publishers.
  self.startUniversalSubs();

  if (version !== 'pre1' && options.heartbeatInterval !== 0) {
    // We no longer need the low level timeout because we have heartbeats.
    socket.setWebsocketTimeout(0);

    self.heartbeat = new DDPCommon.Heartbeat({
      heartbeatInterval: options.heartbeatInterval,
      heartbeatTimeout: options.heartbeatTimeout,
      onTimeout: function () {
        self.close();
      },
      sendPing: function () {
        self.send({msg: 'ping'});
      }
    });
    self.heartbeat.start();
  }

  Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact(
    "livedata", "sessions", 1);
};

Object.assign(Session.prototype, {
  sendReady: function (subscriptionIds) {
    var self = this;
    if (self._isSending) {
      self.send({msg: "ready", subs: subscriptionIds});
    } else {
      subscriptionIds.forEach(function (subscriptionId) {
        self._pendingReady.push(subscriptionId);
      });
    }
  },

  _canSend(collectionName) {
    return this._isSending || !this.server.getPublicationStrategy(collectionName).useCollectionView;
  },


  sendAdded(collectionName, id, fields) {
    if (this._canSend(collectionName)) {
      this.send({ msg: 'added', collection: collectionName, id, fields });
    }
  },

  sendChanged(collectionName, id, fields) {
    if (isEmpty(fields))
      return;

    if (this._canSend(collectionName)) {
      this.send({
        msg: "changed",
        collection: collectionName,
        id,
        fields
      });
    }
  },

  sendRemoved(collectionName, id) {
    if (this._canSend(collectionName)) {
      this.send({msg: "removed", collection: collectionName, id});
    }
  },

  getSendCallbacks: function () {
    var self = this;
    return {
      added: self.sendAdded.bind(self),
      changed: self.sendChanged.bind(self),
      removed: self.sendRemoved.bind(self)
    };
  },

  getCollectionView: function (collectionName) {
    var self = this;
    var ret = self.collectionViews.get(collectionName);
    if (!ret) {
      ret = new SessionCollectionView(collectionName,
                                        self.getSendCallbacks());
      self.collectionViews.set(collectionName, ret);
    }
    return ret;
  },

  added(subscriptionHandle, collectionName, id, fields) {
    if (this.server.getPublicationStrategy(collectionName).useCollectionView) {
      const view = this.getCollectionView(collectionName);
      view.added(subscriptionHandle, id, fields);
    } else {
      this.sendAdded(collectionName, id, fields);
    }
  },

  removed(subscriptionHandle, collectionName, id) {
    if (this.server.getPublicationStrategy(collectionName).useCollectionView) {
      const view = this.getCollectionView(collectionName);
      view.removed(subscriptionHandle, id);
      if (view.isEmpty()) {
         this.collectionViews.delete(collectionName);
      }
    } else {
      this.sendRemoved(collectionName, id);
    }
  },

  changed(subscriptionHandle, collectionName, id, fields) {
    if (this.server.getPublicationStrategy(collectionName).useCollectionView) {
      const view = this.getCollectionView(collectionName);
      view.changed(subscriptionHandle, id, fields);
    } else {
      this.sendChanged(collectionName, id, fields);
    }
  },

  startUniversalSubs: function () {
    var self = this;
    // Make a shallow copy of the set of universal handlers and start them. If
    // additional universal publishers start while we're running them (due to
    // yielding), they will run separately as part of Server.publish.
    var handlers = [...self.server.universal_publish_handlers];
    handlers.forEach(function (handler) {
      self._startSubscription(handler);
    });
  },

  // Destroy this session and unregister it at the server.
  close: function () {
    var self = this;

    // Destroy this session, even if it's not registered at the
    // server. Stop all processing and tear everything down. If a socket
    // was attached, close it.

    // Already destroyed.
    if (! self.inQueue)
      return;

    // Drop the merge box data immediately.
    self.inQueue = null;
    self.collectionViews = new Map();

    if (self.heartbeat) {
      self.heartbeat.stop();
      self.heartbeat = null;
    }

    if (self.socket) {
      self.socket.close();
      self.socket._meteorSession = null;
    }

    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact(
      "livedata", "sessions", -1);

    Meteor.defer(function () {
      // Stop callbacks can yield, so we defer this on close.
      // sub._isDeactivated() detects that we set inQueue to null and
      // treats it as semi-deactivated (it will ignore incoming callbacks, etc).
      self._deactivateAllSubscriptions();

      // Defer calling the close callbacks, so that the caller closing
      // the session isn't waiting for all the callbacks to complete.
      self._closeCallbacks.forEach(function (callback) {
        callback();
      });
    });

    // Unregister the session.
    self.server._removeSession(self);
  },

  // Send a message (doing nothing if no socket is connected right now).
  // It should be a JSON object (it will be stringified).
  send: function (msg) {
    const self = this;
    if (self.socket) {
      if (Meteor._printSentDDP)
        Meteor._debug("Sent DDP", DDPCommon.stringifyDDP(msg));
      self.socket.send(DDPCommon.stringifyDDP(msg));
    }
  },

  // Send a connection error.
  sendError: function (reason, offendingMessage) {
    var self = this;
    var msg = {msg: 'error', reason: reason};
    if (offendingMessage)
      msg.offendingMessage = offendingMessage;
    self.send(msg);
  },

  // Process 'msg' as an incoming message. As a guard against
  // race conditions during reconnection, ignore the message if
  // 'socket' is not the currently connected socket.
  //
  // We run the messages from the client one at a time, in the order
  // given by the client. The message handler is passed an idempotent
  // function 'unblock' which it may call to allow other messages to
  // begin running in parallel in another fiber (for example, a method
  // that wants to yield). Otherwise, it is automatically unblocked
  // when it returns.
  //
  // Actually, we don't have to 'totally order' the messages in this
  // way, but it's the easiest thing that's correct. (unsub needs to
  // be ordered against sub, methods need to be ordered against each
  // other).
  processMessage: function (msg_in) {
    var self = this;
    if (!self.inQueue) // we have been destroyed.
      return;

    // Respond to ping and pong messages immediately without queuing.
    // If the negotiated DDP version is "pre1" which didn't support
    // pings, preserve the "pre1" behavior of responding with a "bad
    // request" for the unknown messages.
    //
    // Fibers are needed because heartbeats use Meteor.setTimeout, which
    // needs a Fiber. We could actually use regular setTimeout and avoid
    // these new fibers, but it is easier to just make everything use
    // Meteor.setTimeout and not think too hard.
    //
    // Any message counts as receiving a pong, as it demonstrates that
    // the client is still alive.
    if (self.heartbeat) {
      self.heartbeat.messageReceived();
    };

    if (self.version !== 'pre1' && msg_in.msg === 'ping') {
      if (self._respondToPings)
        self.send({msg: "pong", id: msg_in.id});
      return;
    }
    if (self.version !== 'pre1' && msg_in.msg === 'pong') {
      // Since everything is a pong, there is nothing to do
      return;
    }

    self.inQueue.push(msg_in);
    if (self.workerRunning)
      return;
    self.workerRunning = true;

    var processNext = function () {
      var msg = self.inQueue && self.inQueue.shift();

      if (!msg) {
        self.workerRunning = false;
        return;
      }

      function runHandlers() {
        var blocked = true;

        var unblock = function () {
          if (!blocked)
            return; // idempotent
          blocked = false;
          processNext();
        };

        self.server.onMessageHook.each(function (callback) {
          callback(msg, self);
          return true;
        });

        if (msg.msg in self.protocol_handlers) {
          const result = self.protocol_handlers[msg.msg].call(
            self,
            msg,
            unblock
          );

          if (Meteor._isPromise(result)) {
            result.finally(() => unblock());
          } else {
            unblock();
          }
        } else {
          self.sendError('Bad request', msg);
          unblock(); // in case the handler didn't already do it
        }
      }

      runHandlers();
    };

    processNext();
  },

  protocol_handlers: {
    sub: async function (msg, unblock) {
      var self = this;

      // cacheUnblock temporarly, so we can capture it later
      // we will use unblock in current eventLoop, so this is safe
      self.cachedUnblock = unblock;

      // reject malformed messages
      if (typeof (msg.id) !== "string" ||
          typeof (msg.name) !== "string" ||
          ('params' in msg && !(msg.params instanceof Array))) {
        self.sendError("Malformed subscription", msg);
        return;
      }

      if (!self.server.publish_handlers[msg.name]) {
        self.send({
          msg: 'nosub', id: msg.id,
          error: new Meteor.Error(404, `Subscription '${msg.name}' not found`)});
        return;
      }

      if (self._namedSubs.has(msg.id))
        // subs are idempotent, or rather, they are ignored if a sub
        // with that id already exists. this is important during
        // reconnect.
        return;

      // XXX It'd be much better if we had generic hooks where any package can
      // hook into subscription handling, but in the mean while we special case
      // ddp-rate-limiter package. This is also done for weak requirements to
      // add the ddp-rate-limiter package in case we don't have Accounts. A
      // user trying to use the ddp-rate-limiter must explicitly require it.
      if (Package['ddp-rate-limiter']) {
        var DDPRateLimiter = Package['ddp-rate-limiter'].DDPRateLimiter;
        var rateLimiterInput = {
          userId: self.userId,
          clientAddress: self.connectionHandle.clientAddress,
          type: "subscription",
          name: msg.name,
          connectionId: self.id
        };

        DDPRateLimiter._increment(rateLimiterInput);
        var rateLimitResult = DDPRateLimiter._check(rateLimiterInput);
        if (!rateLimitResult.allowed) {
          self.send({
            msg: 'nosub', id: msg.id,
            error: new Meteor.Error(
              'too-many-requests',
              DDPRateLimiter.getErrorMessage(rateLimitResult),
              {timeToReset: rateLimitResult.timeToReset})
          });
          return;
        }
      }

      var handler = self.server.publish_handlers[msg.name];

      await self._startSubscription(handler, msg.id, msg.params, msg.name);

      // cleaning cached unblock
      self.cachedUnblock = null;
    },

    unsub: function (msg) {
      var self = this;

      self._stopSubscription(msg.id);
    },

    method: async function (msg, unblock) {
      var self = this;

      // Reject malformed messages.
      // For now, we silently ignore unknown attributes,
      // for forwards compatibility.
      if (typeof (msg.id) !== "string" ||
          typeof (msg.method) !== "string" ||
          ('params' in msg && !(msg.params instanceof Array)) ||
          (('randomSeed' in msg) && (typeof msg.randomSeed !== "string"))) {
        self.sendError("Malformed method invocation", msg);
        return;
      }

      var randomSeed = msg.randomSeed || null;

      // Set up to mark the method as satisfied once all observers
      // (and subscriptions) have reacted to any writes that were
      // done.
      var fence = new DDPServer._WriteFence;
      fence.onAllCommitted(function () {
        // Retire the fence so that future writes are allowed.
        // This means that callbacks like timers are free to use
        // the fence, and if they fire before it's armed (for
        // example, because the method waits for them) their
        // writes will be included in the fence.
        fence.retire();
        self.send({msg: 'updated', methods: [msg.id]});
      });

      // Find the handler
      var handler = self.server.method_handlers[msg.method];
      if (!handler) {
        self.send({
          msg: 'result', id: msg.id,
          error: new Meteor.Error(404, `Method '${msg.method}' not found`)});
        await fence.arm();
        return;
      }

      var invocation = new DDPCommon.MethodInvocation({
        name: msg.method,
        isSimulation: false,
        userId: self.userId,
        setUserId(userId) {
          return self._setUserId(userId);
        },
        unblock: unblock,
        connection: self.connectionHandle,
        randomSeed: randomSeed,
        fence,
      });

      const promise = new Promise((resolve, reject) => {
        // XXX It'd be better if we could hook into method handlers better but
        // for now, we need to check if the ddp-rate-limiter exists since we
        // have a weak requirement for the ddp-rate-limiter package to be added
        // to our application.
        if (Package['ddp-rate-limiter']) {
          var DDPRateLimiter = Package['ddp-rate-limiter'].DDPRateLimiter;
          var rateLimiterInput = {
            userId: self.userId,
            clientAddress: self.connectionHandle.clientAddress,
            type: "method",
            name: msg.method,
            connectionId: self.id
          };
          DDPRateLimiter._increment(rateLimiterInput);
          var rateLimitResult = DDPRateLimiter._check(rateLimiterInput)
          if (!rateLimitResult.allowed) {
            reject(new Meteor.Error(
              "too-many-requests",
              DDPRateLimiter.getErrorMessage(rateLimitResult),
              {timeToReset: rateLimitResult.timeToReset}
            ));
            return;
          }
        }

        resolve(DDPServer._CurrentWriteFence.withValue(
          fence,
          () => DDP._CurrentMethodInvocation.withValue(
            invocation,
            () => maybeAuditArgumentChecks(
              handler, invocation, msg.params,
              "call to '" + msg.method + "'"
            )
          )
        ));
      });

      async function finish() {
        await fence.arm();
        unblock();
      }

      const payload = {
        msg: "result",
        id: msg.id
      };
      return promise.then(async result => {
        await finish();
        if (result !== undefined) {
          payload.result = result;
        }
        self.send(payload);
      }, async (exception) => {
        await finish();
        payload.error = wrapInternalException(
          exception,
          `while invoking method '${msg.method}'`
        );
        self.send(payload);
      });
    }
  },

  _eachSub: function (f) {
    var self = this;
    self._namedSubs.forEach(f);
    self._universalSubs.forEach(f);
  },

  _diffCollectionViews: function (beforeCVs) {
    var self = this;
    DiffSequence.diffMaps(beforeCVs, self.collectionViews, {
      both: function (collectionName, leftValue, rightValue) {
        rightValue.diff(leftValue);
      },
      rightOnly: function (collectionName, rightValue) {
        rightValue.documents.forEach(function (docView, id) {
          self.sendAdded(collectionName, id, docView.getFields());
        });
      },
      leftOnly: function (collectionName, leftValue) {
        leftValue.documents.forEach(function (doc, id) {
          self.sendRemoved(collectionName, id);
        });
      }
    });
  },

  // Sets the current user id in all appropriate contexts and reruns
  // all subscriptions
  async _setUserId(userId) {
    var self = this;

    if (userId !== null && typeof userId !== "string")
      throw new Error("setUserId must be called on string or null, not " +
                      typeof userId);

    // Prevent newly-created universal subscriptions from being added to our
    // session. They will be found below when we call startUniversalSubs.
    //
    // (We don't have to worry about named subscriptions, because we only add
    // them when we process a 'sub' message. We are currently processing a
    // 'method' message, and the method did not unblock, because it is illegal
    // to call setUserId after unblock. Thus we cannot be concurrently adding a
    // new named subscription).
    self._dontStartNewUniversalSubs = true;

    // Prevent current subs from updating our collectionViews and call their
    // stop callbacks. This may yield.
    self._eachSub(function (sub) {
      sub._deactivate();
    });

    // All subs should now be deactivated. Stop sending messages to the client,
    // save the state of the published collections, reset to an empty view, and
    // update the userId.
    self._isSending = false;
    var beforeCVs = self.collectionViews;
    self.collectionViews = new Map();
    self.userId = userId;

    // _setUserId is normally called from a Meteor method with
    // DDP._CurrentMethodInvocation set. But DDP._CurrentMethodInvocation is not
    // expected to be set inside a publish function, so we temporary unset it.
    // Inside a publish function DDP._CurrentPublicationInvocation is set.
    await DDP._CurrentMethodInvocation.withValue(undefined, async function () {
      // Save the old named subs, and reset to having no subscriptions.
      var oldNamedSubs = self._namedSubs;
      self._namedSubs = new Map();
      self._universalSubs = [];



      await Promise.all([...oldNamedSubs].map(async ([subscriptionId, sub]) => {
        const newSub = sub._recreate();
        self._namedSubs.set(subscriptionId, newSub);
        // nb: if the handler throws or calls this.error(), it will in fact
        // immediately send its 'nosub'. This is OK, though.
        await newSub._runHandler();
      }));

      // Allow newly-created universal subs to be started on our connection in
      // parallel with the ones we're spinning up here, and spin up universal
      // subs.
      self._dontStartNewUniversalSubs = false;
      self.startUniversalSubs();
    }, { name: '_setUserId' });

    // Start sending messages again, beginning with the diff from the previous
    // state of the world to the current state. No yields are allowed during
    // this diff, so that other changes cannot interleave.
    Meteor._noYieldsAllowed(function () {
      self._isSending = true;
      self._diffCollectionViews(beforeCVs);
      if (!isEmpty(self._pendingReady)) {
        self.sendReady(self._pendingReady);
        self._pendingReady = [];
      }
    });
  },

  _startSubscription: function (handler, subId, params, name) {
    var self = this;

    var sub = new Subscription(
      self, handler, subId, params, name);

    let unblockHander = self.cachedUnblock;
    // _startSubscription may call from a lot places
    // so cachedUnblock might be null in somecases
    // assign the cachedUnblock
    sub.unblock = unblockHander || (() => {});

    if (subId)
      self._namedSubs.set(subId, sub);
    else
      self._universalSubs.push(sub);

    return sub._runHandler();
  },

  // Tear down specified subscription
  _stopSubscription: function (subId, error) {
    var self = this;

    var subName = null;
    if (subId) {
      var maybeSub = self._namedSubs.get(subId);
      if (maybeSub) {
        subName = maybeSub._name;
        maybeSub._removeAllDocuments();
        maybeSub._deactivate();
        self._namedSubs.delete(subId);
      }
    }

    var response = {msg: 'nosub', id: subId};

    if (error) {
      response.error = wrapInternalException(
        error,
        subName ? ("from sub " + subName + " id " + subId)
          : ("from sub id " + subId));
    }

    self.send(response);
  },

  // Tear down all subscriptions. Note that this does NOT send removed or nosub
  // messages, since we assume the client is gone.
  _deactivateAllSubscriptions: function () {
    var self = this;

    self._namedSubs.forEach(function (sub, id) {
      sub._deactivate();
    });
    self._namedSubs = new Map();

    self._universalSubs.forEach(function (sub) {
      sub._deactivate();
    });
    self._universalSubs = [];
  },

  // Determine the remote client's IP address, based on the
  // HTTP_FORWARDED_COUNT environment variable representing how many
  // proxies the server is behind.
  _clientAddress: function () {
    var self = this;

    // For the reported client address for a connection to be correct,
    // the developer must set the HTTP_FORWARDED_COUNT environment
    // variable to an integer representing the number of hops they
    // expect in the `x-forwarded-for` header. E.g., set to "1" if the
    // server is behind one proxy.
    //
    // This could be computed once at startup instead of every time.
    var httpForwardedCount = parseInt(process.env['HTTP_FORWARDED_COUNT']) || 0;

    if (httpForwardedCount === 0)
      return self.socket.remoteAddress;

    var forwardedFor = self.socket.headers["x-forwarded-for"];
    if (!isString(forwardedFor))
      return null;
    forwardedFor = forwardedFor.trim().split(/\s*,\s*/);

    // Typically the first value in the `x-forwarded-for` header is
    // the original IP address of the client connecting to the first
    // proxy.  However, the end user can easily spoof the header, in
    // which case the first value(s) will be the fake IP address from
    // the user pretending to be a proxy reporting the original IP
    // address value.  By counting HTTP_FORWARDED_COUNT back from the
    // end of the list, we ensure that we get the IP address being
    // reported by *our* first proxy.

    if (httpForwardedCount < 0 || httpForwardedCount > forwardedFor.length)
      return null;

    return forwardedFor[forwardedFor.length - httpForwardedCount];
  }
});

/******************************************************************************/
/* Subscription                                                               */
/******************************************************************************/

// Ctor for a sub handle: the input to each publish function

// Instance name is this because it's usually referred to as this inside a
// publish
/**
 * @summary The server's side of a subscription
 * @class Subscription
 * @instanceName this
 * @showInstanceName true
 */
var Subscription = function (
    session, handler, subscriptionId, params, name) {
  var self = this;
  self._session = session; // type is Session

  /**
   * @summary Access inside the publish function. The incoming [connection](#meteor_onconnection) for this subscription.
   * @locus Server
   * @name  connection
   * @memberOf Subscription
   * @instance
   */
  self.connection = session.connectionHandle; // public API object

  self._handler = handler;

  // My subscription ID (generated by client, undefined for universal subs).
  self._subscriptionId = subscriptionId;
  // Undefined for universal subs
  self._name = name;

  self._params = params || [];

  // Only named subscriptions have IDs, but we need some sort of string
  // internally to keep track of all subscriptions inside
  // SessionDocumentViews. We use this subscriptionHandle for that.
  if (self._subscriptionId) {
    self._subscriptionHandle = 'N' + self._subscriptionId;
  } else {
    self._subscriptionHandle = 'U' + Random.id();
  }

  // Has _deactivate been called?
  self._deactivated = false;

  // Stop callbacks to g/c this sub.  called w/ zero arguments.
  self._stopCallbacks = [];

  // The set of (collection, documentid) that this subscription has
  // an opinion about.
  self._documents = new Map();

  // Remember if we are ready.
  self._ready = false;

  // Part of the public API: the user of this sub.

  /**
   * @summary Access inside the publish function. The id of the logged-in user, or `null` if no user is logged in.
   * @locus Server
   * @memberOf Subscription
   * @name  userId
   * @instance
   */
  self.userId = session.userId;

  // For now, the id filter is going to default to
  // the to/from DDP methods on MongoID, to
  // specifically deal with mongo/minimongo ObjectIds.

  // Later, you will be able to make this be "raw"
  // if you want to publish a collection that you know
  // just has strings for keys and no funny business, to
  // a DDP consumer that isn't minimongo.

  self._idFilter = {
    idStringify: MongoID.idStringify,
    idParse: MongoID.idParse
  };

  Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact(
    "livedata", "subscriptions", 1);
};

Object.assign(Subscription.prototype, {
  _runHandler: async function() {
    // XXX should we unblock() here? Either before running the publish
    // function, or before running _publishCursor.
    //
    // Right now, each publish function blocks all future publishes and
    // methods waiting on data from Mongo (or whatever else the function
    // blocks on). This probably slows page load in common cases.

    if (!this.unblock) {
      this.unblock = () => {};
    }

    const self = this;
    let resultOrThenable = null;
    try {
      resultOrThenable = DDP._CurrentPublicationInvocation.withValue(
        self,
        () =>
          maybeAuditArgumentChecks(
            self._handler,
            self,
            EJSON.clone(self._params),
            // It's OK that this would look weird for universal subscriptions,
            // because they have no arguments so there can never be an
            // audit-argument-checks failure.
            "publisher '" + self._name + "'"
          ),
        { name: self._name }
      );
    } catch (e) {
      self.error(e);
      return;
    }

    // Did the handler call this.error or this.stop?
    if (self._isDeactivated()) return;

    // Both conventional and async publish handler functions are supported.
    // If an object is returned with a then() function, it is either a promise
    // or thenable and will be resolved asynchronously.
    const isThenable =
      resultOrThenable && typeof resultOrThenable.then === 'function';
    if (isThenable) {
      try {
        await self._publishHandlerResult(await resultOrThenable);
      } catch(e) {
        self.error(e)
      }
    } else {
      await self._publishHandlerResult(resultOrThenable);
    }
  },

  async _publishHandlerResult (res) {
    // SPECIAL CASE: Instead of writing their own callbacks that invoke
    // this.added/changed/ready/etc, the user can just return a collection
    // cursor or array of cursors from the publish function; we call their
    // _publishCursor method which starts observing the cursor and publishes the
    // results. Note that _publishCursor does NOT call ready().
    //
    // XXX This uses an undocumented interface which only the Mongo cursor
    // interface publishes. Should we make this interface public and encourage
    // users to implement it themselves? Arguably, it's unnecessary; users can
    // already write their own functions like
    //   var publishMyReactiveThingy = function (name, handler) {
    //     Meteor.publish(name, function () {
    //       var reactiveThingy = handler();
    //       reactiveThingy.publishMe();
    //     });
    //   };

    var self = this;
    var isCursor = function (c) {
      return c && c._publishCursor;
    };
    if (isCursor(res)) {
      try {
        await res._publishCursor(self);
      } catch (e) {
        self.error(e);
        return;
      }
      // _publishCursor only returns after the initial added callbacks have run.
      // mark subscription as ready.
      self.ready();
    } else if (Array.isArray(res)) {
      // Check all the elements are cursors
      if (! res.every(isCursor)) {
        self.error(new Error("Publish function returned an array of non-Cursors"));
        return;
      }
      // Find duplicate collection names
      // XXX we should support overlapping cursors, but that would require the
      // merge box to allow overlap within a subscription
      var collectionNames = {};

      for (var i = 0; i < res.length; ++i) {
        var collectionName = res[i]._getCollectionName();
        if (collectionNames[collectionName]) {
          self.error(new Error(
            "Publish function returned multiple cursors for collection " +
              collectionName));
          return;
        }
        collectionNames[collectionName] = true;
      }

      try {
        await Promise.all(res.map(cur => cur._publishCursor(self)));
      } catch (e) {
        self.error(e);
        return;
      }
      self.ready();
    } else if (res) {
      // Truthy values other than cursors or arrays are probably a
      // user mistake (possible returning a Mongo document via, say,
      // `coll.findOne()`).
      self.error(new Error("Publish function can only return a Cursor or "
                           + "an array of Cursors"));
    }
  },

  // This calls all stop callbacks and prevents the handler from updating any
  // SessionCollectionViews further. It's used when the user unsubscribes or
  // disconnects, as well as during setUserId re-runs. It does *NOT* send
  // removed messages for the published objects; if that is necessary, call
  // _removeAllDocuments first.
  _deactivate: function() {
    var self = this;
    if (self._deactivated)
      return;
    self._deactivated = true;
    self._callStopCallbacks();
    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact(
      "livedata", "subscriptions", -1);
  },

  _callStopCallbacks: function () {
    var self = this;
    // Tell listeners, so they can clean up
    var callbacks = self._stopCallbacks;
    self._stopCallbacks = [];
    callbacks.forEach(function (callback) {
      callback();
    });
  },

  // Send remove messages for every document.
  _removeAllDocuments: function () {
    var self = this;
    Meteor._noYieldsAllowed(function () {
      self._documents.forEach(function (collectionDocs, collectionName) {
        collectionDocs.forEach(function (strId) {
          self.removed(collectionName, self._idFilter.idParse(strId));
        });
      });
    });
  },

  // Returns a new Subscription for the same session with the same
  // initial creation parameters. This isn't a clone: it doesn't have
  // the same _documents cache, stopped state or callbacks; may have a
  // different _subscriptionHandle, and gets its userId from the
  // session, not from this object.
  _recreate: function () {
    var self = this;
    return new Subscription(
      self._session, self._handler, self._subscriptionId, self._params,
      self._name);
  },

  /**
   * @summary Call inside the publish function.  Stops this client's subscription, triggering a call on the client to the `onStop` callback passed to [`Meteor.subscribe`](#meteor_subscribe), if any. If `error` is not a [`Meteor.Error`](#meteor_error), it will be [sanitized](#meteor_error).
   * @locus Server
   * @param {Error} error The error to pass to the client.
   * @instance
   * @memberOf Subscription
   */
  error: function (error) {
    var self = this;
    if (self._isDeactivated())
      return;
    self._session._stopSubscription(self._subscriptionId, error);
  },

  // Note that while our DDP client will notice that you've called stop() on the
  // server (and clean up its _subscriptions table) we don't actually provide a
  // mechanism for an app to notice this (the subscribe onError callback only
  // triggers if there is an error).

  /**
   * @summary Call inside the publish function.  Stops this client's subscription and invokes the client's `onStop` callback with no error.
   * @locus Server
   * @instance
   * @memberOf Subscription
   */
  stop: function () {
    var self = this;
    if (self._isDeactivated())
      return;
    self._session._stopSubscription(self._subscriptionId);
  },

  /**
   * @summary Call inside the publish function.  Registers a callback function to run when the subscription is stopped.
   * @locus Server
   * @memberOf Subscription
   * @instance
   * @param {Function} func The callback function
   */
  onStop: function (callback) {
    var self = this;
    callback = Meteor.bindEnvironment(callback, 'onStop callback', self);
    if (self._isDeactivated())
      callback();
    else
      self._stopCallbacks.push(callback);
  },

  // This returns true if the sub has been deactivated, *OR* if the session was
  // destroyed but the deferred call to _deactivateAllSubscriptions hasn't
  // happened yet.
  _isDeactivated: function () {
    var self = this;
    return self._deactivated || self._session.inQueue === null;
  },

  /**
   * @summary Call inside the publish function.  Informs the subscriber that a document has been added to the record set.
   * @locus Server
   * @memberOf Subscription
   * @instance
   * @param {String} collection The name of the collection that contains the new document.
   * @param {String} id The new document's ID.
   * @param {Object} fields The fields in the new document.  If `_id` is present it is ignored.
   */
  added (collectionName, id, fields) {
    if (this._isDeactivated())
      return;
    id = this._idFilter.idStringify(id);

    if (this._session.server.getPublicationStrategy(collectionName).doAccountingForCollection) {
      let ids = this._documents.get(collectionName);
      if (ids == null) {
        ids = new Set();
        this._documents.set(collectionName, ids);
      }
      ids.add(id);
    }

    this._session.added(this._subscriptionHandle, collectionName, id, fields);
  },

  /**
   * @summary Call inside the publish function.  Informs the subscriber that a document in the record set has been modified.
   * @locus Server
   * @memberOf Subscription
   * @instance
   * @param {String} collection The name of the collection that contains the changed document.
   * @param {String} id The changed document's ID.
   * @param {Object} fields The fields in the document that have changed, together with their new values.  If a field is not present in `fields` it was left unchanged; if it is present in `fields` and has a value of `undefined` it was removed from the document.  If `_id` is present it is ignored.
   */
  changed (collectionName, id, fields) {
    if (this._isDeactivated())
      return;
    id = this._idFilter.idStringify(id);
    this._session.changed(this._subscriptionHandle, collectionName, id, fields);
  },

  /**
   * @summary Call inside the publish function.  Informs the subscriber that a document has been removed from the record set.
   * @locus Server
   * @memberOf Subscription
   * @instance
   * @param {String} collection The name of the collection that the document has been removed from.
   * @param {String} id The ID of the document that has been removed.
   */
  removed (collectionName, id) {
    if (this._isDeactivated())
      return;
    id = this._idFilter.idStringify(id);

    if (this._session.server.getPublicationStrategy(collectionName).doAccountingForCollection) {
      // We don't bother to delete sets of things in a collection if the
      // collection is empty.  It could break _removeAllDocuments.
      this._documents.get(collectionName).delete(id);
    }

    this._session.removed(this._subscriptionHandle, collectionName, id);
  },

  /**
   * @summary Call inside the publish function.  Informs the subscriber that an initial, complete snapshot of the record set has been sent.  This will trigger a call on the client to the `onReady` callback passed to  [`Meteor.subscribe`](#meteor_subscribe), if any.
   * @locus Server
   * @memberOf Subscription
   * @instance
   */
  ready: function () {
    var self = this;
    if (self._isDeactivated())
      return;
    if (!self._subscriptionId)
      return;  // Unnecessary but ignored for universal sub
    if (!self._ready) {
      self._session.sendReady([self._subscriptionId]);
      self._ready = true;
    }
  }
});

/******************************************************************************/
/* Server                                                                     */
/******************************************************************************/

Server = function (options = {}) {
  var self = this;

  // The default heartbeat interval is 30 seconds on the server and 35
  // seconds on the client.  Since the client doesn't need to send a
  // ping as long as it is receiving pings, this means that pings
  // normally go from the server to the client.
  //
  // Note: Troposphere depends on the ability to mutate
  // Meteor.server.options.heartbeatTimeout! This is a hack, but it's life.
  self.options = {
    heartbeatInterval: 15000,
    heartbeatTimeout: 15000,
    // For testing, allow responding to pings to be disabled.
    respondToPings: true,
    defaultPublicationStrategy: publicationStrategies.SERVER_MERGE,
    ...options,
  };

  // Map of callbacks to call when a new connection comes in to the
  // server and completes DDP version negotiation. Use an object instead
  // of an array so we can safely remove one from the list while
  // iterating over it.
  self.onConnectionHook = new Hook({
    debugPrintExceptions: "onConnection callback"
  });

  // Map of callbacks to call when a new message comes in.
  self.onMessageHook = new Hook({
    debugPrintExceptions: "onMessage callback"
  });

  self.publish_handlers = {};
  self.universal_publish_handlers = [];

  self.method_handlers = {};

  self._publicationStrategies = {};

  self.sessions = new Map(); // map from id to session

  self.stream_server = new StreamServer();

  self.stream_server.register(function (socket) {
    // socket implements the SockJSConnection interface
    socket._meteorSession = null;

    var sendError = function (reason, offendingMessage) {
      var msg = {msg: 'error', reason: reason};
      if (offendingMessage)
        msg.offendingMessage = offendingMessage;
      socket.send(DDPCommon.stringifyDDP(msg));
    };

    socket.on('data', function (raw_msg) {
      if (Meteor._printReceivedDDP) {
        Meteor._debug("Received DDP", raw_msg);
      }
      try {
        try {
          var msg = DDPCommon.parseDDP(raw_msg);
        } catch (err) {
          sendError('Parse error');
          return;
        }
        if (msg === null || !msg.msg) {
          sendError('Bad request', msg);
          return;
        }

        if (msg.msg === 'connect') {
          if (socket._meteorSession) {
            sendError("Already connected", msg);
            return;
          }

          self._handleConnect(socket, msg);

          return;
        }

        if (!socket._meteorSession) {
          sendError('Must connect first', msg);
          return;
        }
        socket._meteorSession.processMessage(msg);
      } catch (e) {
        // XXX print stack nicely
        Meteor._debug("Internal exception while processing message", msg, e);
      }
    });

    socket.on('close', function () {
      if (socket._meteorSession) {
        socket._meteorSession.close();
      }
    });
  });
};

Object.assign(Server.prototype, {

  /**
   * @summary Register a callback to be called when a new DDP connection is made to the server.
   * @locus Server
   * @param {function} callback The function to call when a new DDP connection is established.
   * @memberOf Meteor
   * @importFromPackage meteor
   */
  onConnection: function (fn) {
    var self = this;
    return self.onConnectionHook.register(fn);
  },

  /**
   * @summary Set publication strategy for the given collection. Publications strategies are available from `DDPServer.publicationStrategies`. You call this method from `Meteor.server`, like `Meteor.server.setPublicationStrategy()`
   * @locus Server
   * @alias setPublicationStrategy
   * @param collectionName {String}
   * @param strategy {{useCollectionView: boolean, doAccountingForCollection: boolean}}
   * @memberOf Meteor.server
   * @importFromPackage meteor
   */
  setPublicationStrategy(collectionName, strategy) {
    if (!Object.values(publicationStrategies).includes(strategy)) {
      throw new Error(`Invalid merge strategy: ${strategy} 
        for collection ${collectionName}`);
    }
    this._publicationStrategies[collectionName] = strategy;
  },

  /**
   * @summary Gets the publication strategy for the requested collection. You call this method from `Meteor.server`, like `Meteor.server.getPublicationStrategy()`
   * @locus Server
   * @alias getPublicationStrategy
   * @param collectionName {String}
   * @memberOf Meteor.server
   * @importFromPackage meteor
   * @return {{useCollectionView: boolean, doAccountingForCollection: boolean}}
   */
  getPublicationStrategy(collectionName) {
    return this._publicationStrategies[collectionName]
      || this.options.defaultPublicationStrategy;
  },

  /**
   * @summary Register a callback to be called when a new DDP message is received.
   * @locus Server
   * @param {function} callback The function to call when a new DDP message is received.
   * @memberOf Meteor
   * @importFromPackage meteor
   */
  onMessage: function (fn) {
    var self = this;
    return self.onMessageHook.register(fn);
  },

  _handleConnect: function (socket, msg) {
    var self = this;

    // The connect message must specify a version and an array of supported
    // versions, and it must claim to support what it is proposing.
    if (!(typeof (msg.version) === 'string' &&
          Array.isArray(msg.support) &&
          msg.support.every(isString) &&
          msg.support.includes(msg.version))) {
      socket.send(DDPCommon.stringifyDDP({msg: 'failed',
                                version: DDPCommon.SUPPORTED_DDP_VERSIONS[0]}));
      socket.close();
      return;
    }

    // In the future, handle session resumption: something like:
    //  socket._meteorSession = self.sessions[msg.session]
    var version = calculateVersion(msg.support, DDPCommon.SUPPORTED_DDP_VERSIONS);

    if (msg.version !== version) {
      // The best version to use (according to the client's stated preferences)
      // is not the one the client is trying to use. Inform them about the best
      // version to use.
      socket.send(DDPCommon.stringifyDDP({msg: 'failed', version: version}));
      socket.close();
      return;
    }

    // Yay, version matches! Create a new session.
    // Note: Troposphere depends on the ability to mutate
    // Meteor.server.options.heartbeatTimeout! This is a hack, but it's life.
    socket._meteorSession = new Session(self, version, socket, self.options);
    self.sessions.set(socket._meteorSession.id, socket._meteorSession);
    self.onConnectionHook.each(function (callback) {
      if (socket._meteorSession)
        callback(socket._meteorSession.connectionHandle);
      return true;
    });
  },
  /**
   * Register a publish handler function.
   *
   * @param name {String} identifier for query
   * @param handler {Function} publish handler
   * @param options {Object}
   *
   * Server will call handler function on each new subscription,
   * either when receiving DDP sub message for a named subscription, or on
   * DDP connect for a universal subscription.
   *
   * If name is null, this will be a subscription that is
   * automatically established and permanently on for all connected
   * client, instead of a subscription that can be turned on and off
   * with subscribe().
   *
   * options to contain:
   *  - (mostly internal) is_auto: true if generated automatically
   *    from an autopublish hook. this is for cosmetic purposes only
   *    (it lets us determine whether to print a warning suggesting
   *    that you turn off autopublish).
   */

  /**
   * @summary Publish a record set.
   * @memberOf Meteor
   * @importFromPackage meteor
   * @locus Server
   * @param {String|Object} name If String, name of the record set.  If Object, publications Dictionary of publish functions by name.  If `null`, the set has no name, and the record set is automatically sent to all connected clients.
   * @param {Function} func Function called on the server each time a client subscribes.  Inside the function, `this` is the publish handler object, described below.  If the client passed arguments to `subscribe`, the function is called with the same arguments.
   */
  publish: function (name, handler, options) {
    var self = this;

    if (!isObject(name)) {
      options = options || {};

      if (name && name in self.publish_handlers) {
        Meteor._debug("Ignoring duplicate publish named '" + name + "'");
        return;
      }

      if (Package.autopublish && !options.is_auto) {
        // They have autopublish on, yet they're trying to manually
        // pick stuff to publish. They probably should turn off
        // autopublish. (This check isn't perfect -- if you create a
        // publish before you turn on autopublish, it won't catch
        // it, but this will definitely handle the simple case where
        // you've added the autopublish package to your app, and are
        // calling publish from your app code).
        if (!self.warned_about_autopublish) {
          self.warned_about_autopublish = true;
          Meteor._debug(
    "** You've set up some data subscriptions with Meteor.publish(), but\n" +
    "** you still have autopublish turned on. Because autopublish is still\n" +
    "** on, your Meteor.publish() calls won't have much effect. All data\n" +
    "** will still be sent to all clients.\n" +
    "**\n" +
    "** Turn off autopublish by removing the autopublish package:\n" +
    "**\n" +
    "**   $ meteor remove autopublish\n" +
    "**\n" +
    "** .. and make sure you have Meteor.publish() and Meteor.subscribe() calls\n" +
    "** for each collection that you want clients to see.\n");
        }
      }

      if (name)
        self.publish_handlers[name] = handler;
      else {
        self.universal_publish_handlers.push(handler);
        // Spin up the new publisher on any existing session too. Run each
        // session's subscription in a new Fiber, so that there's no change for
        // self.sessions to change while we're running this loop.
        self.sessions.forEach(function (session) {
          if (!session._dontStartNewUniversalSubs) {
            session._startSubscription(handler);
          }
        });
      }
    }
    else{
      Object.entries(name).forEach(function([key, value]) {
        self.publish(key, value, {});
      });
    }
  },

  _removeSession: function (session) {
    var self = this;
    self.sessions.delete(session.id);
  },

  /**
   * @summary Tells if the method call came from a call or a callAsync.
   * @locus Anywhere
   * @memberOf Meteor
   * @importFromPackage meteor
   * @returns boolean
   */
  isAsyncCall: function(){
    return DDP._CurrentMethodInvocation._isCallAsyncMethodRunning()
  },

  /**
   * @summary Defines functions that can be invoked over the network by clients.
   * @locus Anywhere
   * @param {Object} methods Dictionary whose keys are method names and values are functions.
   * @memberOf Meteor
   * @importFromPackage meteor
   */
  methods: function (methods) {
    var self = this;
    Object.entries(methods).forEach(function ([name, func]) {
      if (typeof func !== 'function')
        throw new Error("Method '" + name + "' must be a function");
      if (self.method_handlers[name])
        throw new Error("A method named '" + name + "' is already defined");
      self.method_handlers[name] = func;
    });
  },

  call: function (name, ...args) {
    if (args.length && typeof args[args.length - 1] === "function") {
      // If it's a function, the last argument is the result callback, not
      // a parameter to the remote method.
      var callback = args.pop();
    }

    return this.apply(name, args, callback);
  },

  // A version of the call method that always returns a Promise.
  callAsync: function (name, ...args) {
    const options = args[0]?.hasOwnProperty('returnStubValue')
      ? args.shift()
      : {};
    DDP._CurrentMethodInvocation._setCallAsyncMethodRunning(true);
    const promise = new Promise((resolve, reject) => {
      DDP._CurrentCallAsyncInvocation._set({ name, hasCallAsyncParent: true });
      this.applyAsync(name, args, { isFromCallAsync: true, ...options })
        .then(resolve)
        .catch(reject)
        .finally(() => {
          DDP._CurrentCallAsyncInvocation._set();
        });
    });
    return promise.finally(() =>
      DDP._CurrentMethodInvocation._setCallAsyncMethodRunning(false)
    );
  },

  apply: function (name, args, options, callback) {
    // We were passed 3 arguments. They may be either (name, args, options)
    // or (name, args, callback)
    if (! callback && typeof options === 'function') {
      callback = options;
      options = {};
    } else {
      options = options || {};
    }
    const promise = this.applyAsync(name, args, options);

    // Return the result in whichever way the caller asked for it. Note that we
    // do NOT block on the write fence in an analogous way to how the client
    // blocks on the relevant data being visible, so you are NOT guaranteed that
    // cursor observe callbacks have fired when your callback is invoked. (We
    // can change this if there's a real use case).
    if (callback) {
      promise.then(
        result => callback(undefined, result),
        exception => callback(exception)
      );
    } else {
      return promise;
    }
  },

  // @param options {Optional Object}
  applyAsync: function (name, args, options) {
    // Run the handler
    var handler = this.method_handlers[name];

    if (! handler) {
      return Promise.reject(
        new Meteor.Error(404, `Method '${name}' not found`)
      );
    }
    // If this is a method call from within another method or publish function,
    // get the user state from the outer method or publish function, otherwise
    // don't allow setUserId to be called
    var userId = null;
    let setUserId = () => {
      throw new Error("Can't call setUserId on a server initiated method call");
    };
    var connection = null;
    var currentMethodInvocation = DDP._CurrentMethodInvocation.get();
    var currentPublicationInvocation = DDP._CurrentPublicationInvocation.get();
    var randomSeed = null;

    if (currentMethodInvocation) {
      userId = currentMethodInvocation.userId;
      setUserId = (userId) => currentMethodInvocation.setUserId(userId);
      connection = currentMethodInvocation.connection;
      randomSeed = DDPCommon.makeRpcSeed(currentMethodInvocation, name);
    } else if (currentPublicationInvocation) {
      userId = currentPublicationInvocation.userId;
      setUserId = (userId) => currentPublicationInvocation._session._setUserId(userId);
      connection = currentPublicationInvocation.connection;
    }

    var invocation = new DDPCommon.MethodInvocation({
      isSimulation: false,
      userId,
      setUserId,
      connection,
      randomSeed
    });

    return new Promise((resolve, reject) => {
      let result;
      try {
        result = DDP._CurrentMethodInvocation.withValue(invocation, () =>
          maybeAuditArgumentChecks(
            handler,
            invocation,
            EJSON.clone(args),
            "internal call to '" + name + "'"
          )
        );
      } catch (e) {
        return reject(e);
      }
      if (!Meteor._isPromise(result)) {
        return resolve(result);
      }
      result.then(r => resolve(r)).catch(reject);
    }).then(EJSON.clone);
  },

  _urlForSession: function (sessionId) {
    var self = this;
    var session = self.sessions.get(sessionId);
    if (session)
      return session._socketUrl;
    else
      return null;
  }
});

var calculateVersion = function (clientSupportedVersions,
                                 serverSupportedVersions) {
  var correctVersion = clientSupportedVersions.find(function (version) {
    return serverSupportedVersions.includes(version);
  });
  if (!correctVersion) {
    correctVersion = serverSupportedVersions[0];
  }
  return correctVersion;
};

DDPServer._calculateVersion = calculateVersion;


// "blind" exceptions other than those that were deliberately thrown to signal
// errors to the client
var wrapInternalException = function (exception, context) {
  if (!exception) return exception;

  // To allow packages to throw errors intended for the client but not have to
  // depend on the Meteor.Error class, `isClientSafe` can be set to true on any
  // error before it is thrown.
  if (exception.isClientSafe) {
    if (!(exception instanceof Meteor.Error)) {
      const originalMessage = exception.message;
      exception = new Meteor.Error(exception.error, exception.reason, exception.details);
      exception.message = originalMessage;
    }
    return exception;
  }

  // Tests can set the '_expectedByTest' flag on an exception so it won't go to
  // the server log.
  if (!exception._expectedByTest) {
    Meteor._debug("Exception " + context, exception.stack);
    if (exception.sanitizedError) {
      Meteor._debug("Sanitized and reported to the client as:", exception.sanitizedError);
      Meteor._debug();
    }
  }

  // Did the error contain more details that could have been useful if caught in
  // server code (or if thrown from non-client-originated code), but also
  // provided a "sanitized" version with more context than 500 Internal server error? Use that.
  if (exception.sanitizedError) {
    if (exception.sanitizedError.isClientSafe)
      return exception.sanitizedError;
    Meteor._debug("Exception " + context + " provides a sanitizedError that " +
                  "does not have isClientSafe property set; ignoring");
  }

  return new Meteor.Error(500, "Internal server error");
};


// Audit argument checks, if the audit-argument-checks package exists (it is a
// weak dependency of this package).
var maybeAuditArgumentChecks = function (f, context, args, description) {
  args = args || [];
  if (Package['audit-argument-checks']) {
    return Match._failIfArgumentsAreNotAllChecked(
      f, context, args, description);
  }
  return f.apply(context, args);
};