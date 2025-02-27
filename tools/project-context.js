
var assert = require("assert");
var _ = require('underscore');

var archinfo = require('./utils/archinfo');
var buildmessage = require('./utils/buildmessage.js');
var catalog = require('./packaging/catalog/catalog.js');
var catalogLocal = require('./packaging/catalog/catalog-local.js');
var Console = require('./console/console.js').Console;
var files = require('./fs/files');
var isopackCacheModule = require('./isobuild/isopack-cache.js');
import { loadIsopackage } from './tool-env/isopackets.js';
var packageMapModule = require('./packaging/package-map.js');
var release = require('./packaging/release.js');
var tropohouse = require('./packaging/tropohouse.js');
var utils = require('./utils/utils.js');
var watch = require('./fs/watch');
var Profile = require('./tool-env/profile').Profile;

// This variable was duplicated due to an issue on importing it.
// The issue only happens on node 14, and is most surely related to this: https://nodejs.org/en/blog/release/v14.0.0/
// !!! When changing this, also change on tools/packaging/catalog/catalog-local.js !!!
const KNOWN_ISOBUILD_FEATURE_PACKAGES = {
  // This package directly calls Plugin.registerCompiler. Package authors
  // must explicitly depend on this feature package to use the API.
  'isobuild:compiler-plugin': ['1.0.0'],

  // This package directly calls Plugin.registerMinifier. Package authors
  // must explicitly depend on this feature package to use the API.
  'isobuild:minifier-plugin': ['1.0.0'],

  // This package directly calls Plugin.registerLinter. Package authors
  // must explicitly depend on this feature package to use the API.
  'isobuild:linter-plugin': ['1.0.0'],

  // This package is only published in the isopack-2 format, not isopack-1 or
  // older. ie, it contains "source" files for compiler plugins, not just
  // JS/CSS/static assets/head/body.
  // This is implicitly added at publish time to any such package; package
  // authors don't have to add it explicitly. It isn't relevant for local
  // packages, which can be rebuilt if possible by the older tool.
  //
  // Specifically, this is to avoid the case where a package is published with a
  // dependency like `api.use('less@1.0.0 || 2.0.0')` and the publication
  // selects the newer compiler plugin version to generate the isopack. The
  // published package (if this feature package wasn't implicitly included)
  // could still be selected by the Version Solver to be used with an old
  // Isobuild... just because less@2.0.0 depends on isobuild:compiler-plugin
  // doesn't mean it couldn't choose less@1.0.0, which is not actually
  // compatible with this published package.  (Constraints of the form described
  // above are not very helpful, but at least we can prevent old Isobuilds from
  // choking on confusing packages.)
  //
  // (Why not isobuild:isopack@2.0.0? Well, that would imply that Version Solver
  // would have to choose only one isobuild:isopack feature version, which
  // doesn't make sense here.)
  'isobuild:isopack-2': ['1.0.0'],

  // This package uses the `prodOnly` metadata flag, which causes it to
  // automatically depend on the `isobuild:prod-only` feature package.
  'isobuild:prod-only': ['1.0.0'],

  // This package depends on a specific version of Cordova. Package authors must
  // explicitly depend on this feature package to indicate that they are not
  // compatible with earlier Cordova versions, which is most likely a result of
  // the Cordova plugins they depend on.
  // One scenario is a package depending on a Cordova plugin or version
  // that is only available on npm, which means downloading the plugin is not
  // supported on versions of Cordova below 5.0.0.
  'isobuild:cordova': ['5.4.0'],

  // This package requires functionality introduced in meteor-tool@1.5.0
  // to enable dynamic module fetching via import(...).
  'isobuild:dynamic-import': ['1.5.0'],

  // This package ensures that processFilesFor{Bundle,Target,Package} are
  // allowed to return a Promise instead of having to await async
  // compilation using fibers and/or futures.
  'isobuild:async-plugins': ['1.6.1'],

  // This package requires functionality introduced in meteor-tools@3.0
  // to enable using top level await
  'isobuild:top-level-await': ['3.0.0'],
}

import {
  optimisticReadJsonOrNull,
  optimisticHashOrNull,
} from "./fs/optimistic";

import {
  mapWhereToArches,
} from "./utils/archinfo";

import Resolver from "./isobuild/resolver";
import { addWatchRoot } from './fs/safe-watcher';

const CAN_DELAY_LEGACY_BUILD = ! JSON.parse(
  process.env.METEOR_DISALLOW_DELAYED_LEGACY_BUILD || "false"
);

// The ProjectContext represents all the context associated with an app:
// metadata files in the `.meteor` directory, the choice of package versions
// used by it, etc.  Any time you want to work with an app, create a
// ProjectContext and call prepareProjectForBuild on it (in a buildmessage
// context).
//
// Note that this should only be used by parts of the code that truly require a
// full project to exist; you won't find any reference to ProjectContext in
// compiler.js or isopack.js, which work on individual files (though they will
// get references to some of the objects which can be stored in a ProjectContext
// such as PackageMap and IsopackCache).  Parts of the code that should deal
// with ProjectContext include command implementations, the parts of bundler.js
// that deal with creating a full project, PackageSource.initFromAppDir, stats
// reporting, etc.
//
// Classes in this file follow the standard protocol where names beginning with
// _ should not be externally accessed.
function ProjectContext(options) {
  var self = this;
  assert.ok(self instanceof ProjectContext);

  if (!options.projectDir)
    throw Error("missing projectDir!");

  self.originalOptions = options;
  self.reset();
}
exports.ProjectContext = ProjectContext;

// The value is the name of the method to call to continue.
var STAGE = {
  INITIAL: '_readProjectMetadata',
  READ_PROJECT_METADATA: '_initializeCatalog',
  INITIALIZE_CATALOG: '_resolveConstraints',
  RESOLVE_CONSTRAINTS: '_downloadMissingPackages',
  DOWNLOAD_MISSING_PACKAGES: '_buildLocalPackages',
  BUILD_LOCAL_PACKAGES: '_saveChangedMetadata',
  SAVE_CHANGED_METADATA: 'DONE'
};

Object.assign(ProjectContext.prototype, {
  reset: function (moreOptions, resetOptions) {
    var self = this;
    // Allow overriding some options until the next call to reset;
    var options = Object.assign({}, self.originalOptions, moreOptions);
    // This is options that are actually directed at reset itself.
    resetOptions = resetOptions || {};

    self.projectDir = options.projectDir;
    self.tropohouse = options.tropohouse || tropohouse.default;

    self._includePackages = options.includePackages;

    self._packageMapFilename = options.packageMapFilename ||
      files.pathJoin(self.projectDir, '.meteor', 'versions');

    self._serverArchitectures = options.serverArchitectures || [];
    // We always need to download host versions of packages, at least for
    // plugins.
    self._serverArchitectures.push(archinfo.host());
    self._serverArchitectures = _.uniq(self._serverArchitectures);

    // test-packages overrides this to load local packages from your real app
    // instead of from test-runner-app.
    self._projectDirForLocalPackages = options.projectDirForLocalPackages ||
      options.projectDir;
    self._explicitlyAddedLocalPackageDirs =
      options.explicitlyAddedLocalPackageDirs;

    // Used to override the directory that Meteor's build process
    // writes to; used by `meteor test` so that you can test your
    // app in parallel to writing it, with an isolated database.
    // You can override the default .meteor/local by specifying
    // METEOR_LOCAL_DIR. You can use relative path if you want it
    // relative to your project directory.
    self.projectLocalDir = process.env.METEOR_LOCAL_DIR ?
      files.pathResolve(options.projectDir,
        files.convertToStandardPath(process.env.METEOR_LOCAL_DIR))
      : (options.projectLocalDir ||
        files.pathJoin(self.projectDir, '.meteor', 'local'));

    addWatchRoot(self.projectDir);

    // Used by 'meteor rebuild'; true to rebuild all packages, or a list of
    // package names.  Deletes the isopacks and their plugin caches.
    self._forceRebuildPackages = options.forceRebuildPackages;

    // Set in a few cases where we really want to only get packages from
    // checkout.
    self._ignorePackageDirsEnvVar = options.ignorePackageDirsEnvVar;

    // Set by some tests where we want to pretend that we don't have packages in
    // the git checkout (because they're using a fake warehouse).
    self._ignoreCheckoutPackages = options.ignoreCheckoutPackages;

    // Set by some tests to override the official catalog.
    self._officialCatalog = options.officialCatalog || catalog.official;

    if (options.alwaysWritePackageMap && options.neverWritePackageMap)
      throw Error("always or never?");

    // Set by 'meteor create' and 'meteor update' to ensure that
    // .meteor/versions is always written even if release.current does not match
    // the project's release.
    self._alwaysWritePackageMap = options.alwaysWritePackageMap;

    // Set by a few special-case commands that call
    // projectConstraintsFile.addConstraints for internal reasons without
    // intending to actually write .meteor/packages and .meteor/versions (eg,
    // 'publish' wants to make sure making sure the test is built, and
    // --get-ready wants to build every conceivable package).
    self._neverWriteProjectConstraintsFile =
      options.neverWriteProjectConstraintsFile;
    self._neverWritePackageMap = options.neverWritePackageMap;

    // Set by 'meteor update' to specify which packages may be updated. Array of
    // package names.
    self._upgradePackageNames = options.upgradePackageNames;
    // Set by 'meteor update' to mean that we should upgrade the
    // "patch" (and wrapNum, etc.) parts of indirect dependencies.
    self._upgradeIndirectDepPatchVersions =
      options.upgradeIndirectDepPatchVersions;

    // Set by publishing commands to ensure that published packages always have
    // a web.cordova slice (because we aren't yet smart enough to just default
    // to using the web.browser slice instead or make a common 'web' slice).
    self._forceIncludeCordovaUnibuild = options.forceIncludeCordovaUnibuild;

    // If explicitly specified as null, use no release for constraints.
    // If specified non-null, should be a release version catalog record.
    // If not specified, defaults to release.current.
    //
    // Note that NONE of these cases are "use the release from
    // self.releaseFile"; after all, if you are explicitly running `meteor
    // --release foo` it will override what is found in .meteor/releases.
    if (_.has(options, 'releaseForConstraints')) {
      self._releaseForConstraints = options.releaseForConstraints || null;
    } else if (release.current.isCheckout()) {
      self._releaseForConstraints = null;
    } else {
      self._releaseForConstraints = release.current.getCatalogReleaseData();
    }

    if (resetOptions.preservePackageMap && self.packageMap) {
      self._cachedVersionsBeforeReset = self.packageMap.toVersionMap();
      // packageMapFile should always exist if packageMap does
      self._oldPackageMapFileHash = self.packageMapFile.fileHash;
    } else {
      self._cachedVersionsBeforeReset = null;
      self._oldPackageMapFileHash = null;
    }

    // The --allow-incompatible-update command-line switch, which allows
    // the version solver to choose versions of root dependencies that are
    // incompatible with the previously chosen versions (i.e. to downgrade
    // them or change their major version).
    self._allowIncompatibleUpdate = options.allowIncompatibleUpdate;

    // If set, we run the linter on the app and local packages.  Set by 'meteor
    // lint', and the runner commands (run/test-packages/debug) when --no-lint
    // is not passed.
    self.lintAppAndLocalPackages = options.lintAppAndLocalPackages;

    // If set, we run the linter on just one local package, with this
    // source root. Set by 'meteor lint' in a package, and 'meteor publish'.
    self._lintPackageWithSourceRoot = options.lintPackageWithSourceRoot;

    // Initialized by readProjectMetadata.
    self.releaseFile = null;
    self.projectConstraintsFile = null;
    self.packageMapFile = null;
    self.platformList = null;
    self.cordovaPluginsFile = null;
    self.appIdentifier = null;
    self.finishedUpgraders = null;

    // Initialized by initializeCatalog.
    self.projectCatalog = null;
    self.localCatalog = null;
    // Once the catalog is read and the names of the "explicitly
    // added" packages are determined, they will be listed here.
    // (See explicitlyAddedLocalPackageDirs.)
    // "Explicitly added" packages are typically present in non-app
    // projects, like the one created by `meteor publish`.  This list
    // is used to avoid pinning such packages to their previous
    // versions when we run the version solver, which prevents an
    // error telling you to pass `--allow-incompatible-update` when
    // you publish your package after bumping the major version.
    self.explicitlyAddedPackageNames = null;

    // Initialized by _resolveConstraints.
    self.packageMap = null;
    self.packageMapDelta = null;

    if (resetOptions.softRefreshIsopacks && self.isopackCache) {
      // Make sure we only hold on to one old isopack cache, not a linked list
      // of all of them.
      self.isopackCache.forgetPreviousIsopackCache();
      self._previousIsopackCache = self.isopackCache;
    } else {
      self._previousIsopackCache = null;
    }
    // Initialized by _buildLocalPackages.
    self.isopackCache = null;

    self._completedStage = STAGE.INITIAL;

    // The resolverResultCache is used by the constraint solver; to
    // us it's just an opaque object.  If we pass it into repeated
    // calls to the constraint solver, the constraint solver can be
    // more efficient by caching or memoizing its work.  We choose not
    // to reset this when reset() is called more than once.
    self._readResolverResultCache();
  },

  /**
   *
   * @return {Promise<*|undefined>}
   */
  readProjectMetadata: function () {
    // don't generate a profiling report for this stage (Profile.run),
    // because all we do here is read a handful of files.
    return this._completeStagesThrough(STAGE.READ_PROJECT_METADATA);
  },
  /**
   *
   * @return {Promise<*|undefined>}
   */
  initializeCatalog: function () {
    return Profile.run('ProjectContext initializeCatalog', () => {
      return this._completeStagesThrough(STAGE.INITIALIZE_CATALOG);
    });
  },
  /**
   *
   * @return {Promise<*|undefined>}
   */
  resolveConstraints: function () {
    return Profile.run('ProjectContext resolveConstraints', () => {
      return this._completeStagesThrough(STAGE.RESOLVE_CONSTRAINTS);
    });
  },

  /**
   *
   * @return {Promise<*|undefined>}
   */
  downloadMissingPackages: function () {
    return Profile.run('ProjectContext downloadMissingPackages', () => {
      return this._completeStagesThrough(STAGE.DOWNLOAD_MISSING_PACKAGES);
    });
  },
  /**
   *
   * @return {Promise<*|undefined>}
   */
  buildLocalPackages: function () {
    return Profile.run('ProjectContext buildLocalPackages', () => {
      return this._completeStagesThrough(STAGE.BUILD_LOCAL_PACKAGES);
    });
  },
  /**
   *
   * @return {Promise<*|undefined>}
   */
  saveChangedMetadata: function () {
    return Profile.run('ProjectContext saveChangedMetadata', () => {
      return this._completeStagesThrough(STAGE.SAVE_CHANGED_METADATA);
    });
  },
  /**
   *
   * @return {Promise<*|undefined>}
   */
  prepareProjectForBuild: function () {
    // This is the same as saveChangedMetadata, but if we insert stages after
    // that one it will continue to mean "fully finished".
    return Profile.run('ProjectContext prepareProjectForBuild', () => {
      return this._completeStagesThrough(STAGE.SAVE_CHANGED_METADATA);
    });
  },

  /**
   *
   * @return {Promise<*|undefined>}
   */
  _completeStagesThrough: function (targetStage) {
    var self = this;
    buildmessage.assertInCapture();

    return buildmessage.enterJob('preparing project', async function () {
      while (self._completedStage !== targetStage) {
        // This error gets thrown if you request to go to a stage that's earlier
        // than where you started. Note that the error will be mildly confusing
        // because the key of STAGE does not match the value.
        if (self._completedStage === STAGE.SAVE_CHANGED_METADATA)
          throw Error("can't find requested stage " + targetStage);

        // The actual value of STAGE.FOO is the name of the method that takes
        // you to the next step after FOO.
        await self[self._completedStage]();
        if (buildmessage.jobHasMessages())
          return;
      }
    });
  },

  getProjectLocalDirectory: function (subdirectory) {
    var self = this;
    return files.pathJoin(self.projectLocalDir, subdirectory);
  },

  getMeteorShellDirectory: function(projectDir) {
    return this.getProjectLocalDirectory("shell");
  },

  // You can call this manually (that is, the public version without
  // an `_`) if you want to do some work before resolving constraints,
  // or you can let prepareProjectForBuild do it for you.
  //
  // This should be pretty fast --- for example, we shouldn't worry about
  // needing to wait for it to be done before we open the runner proxy.
  /**
   *
   * @return {Promise<void>}
   */
  _readProjectMetadata: Profile('_readProjectMetadata', async function () {
    var self = this;
    buildmessage.assertInCapture();

    await buildmessage.enterJob('reading project metadata', async function () {
      // Ensure this is actually a project directory.
      await self._ensureProjectDir();
      if (buildmessage.jobHasMessages())
        return;

      // Read .meteor/release.
      self.releaseFile = new exports.ReleaseFile({
        projectDir: self.projectDir,
        catalog: self._officialCatalog,
      });
      await self.releaseFile.init();
      if (buildmessage.jobHasMessages())
        return;

      // Read .meteor/packages.
      self.projectConstraintsFile = new exports.ProjectConstraintsFile({
        projectDir: self.projectDir,
        includePackages: self._includePackages
      });
      if (buildmessage.jobHasMessages())
        return;

      // Read .meteor/versions.
      self.packageMapFile = new exports.PackageMapFile({
        filename: self._packageMapFilename
      });
      if (buildmessage.jobHasMessages())
        return;

      // Read .meteor/cordova-plugins.
      self.cordovaPluginsFile = new exports.CordovaPluginsFile({
        projectDir: self.projectDir
      });
      await self.cordovaPluginsFile.init();
      if (buildmessage.jobHasMessages())
        return;

      // Read .meteor/platforms, creating it if necessary.
      self.platformList = new exports.PlatformList({
        projectDir: self.projectDir
      });
      await self.platformList._init();

      if (buildmessage.jobHasMessages())
        return;

      // Read .meteor/.id, creating it if necessary.
      await self._ensureAppIdentifier();
      if (buildmessage.jobHasMessages())
        return;

      // Set up an object that knows how to read and write
      // .meteor/.finished-upgraders.
      self.finishedUpgraders = new exports.FinishedUpgraders({
        projectDir: self.projectDir
      });
      if (buildmessage.jobHasMessages())
        return;

      self.meteorConfig = new MeteorConfig({
        appDirectory: self.projectDir,
      });
      if (buildmessage.jobHasMessages()) {
        return;
      }
    });

    self._completedStage = STAGE.READ_PROJECT_METADATA;
  }),

  // Write the new release to .meteor/release and create a
  // .meteor/dev_bundle symlink to the corresponding dev_bundle.
  async writeReleaseFileAndDevBundleLink(releaseName) {
    assert.strictEqual(files.inCheckout(), false);
    await this.releaseFile.write(releaseName);
  },

  _ensureProjectDir: async function () {
    var self = this;
    files.mkdir_p(files.pathJoin(self.projectDir, '.meteor'));

    // This file existing is what makes a project directory a project directory,
    // so let's make sure it exists!
    var constraintFilePath = files.pathJoin(self.projectDir, '.meteor', 'packages');
    if (! files.exists(constraintFilePath)) {
      await files.writeFileAtomically(constraintFilePath, '');
    }

    // Let's also make sure we have a minimal gitignore.
    var gitignorePath = files.pathJoin(self.projectDir, '.meteor', '.gitignore');
    if (! files.exists(gitignorePath)) {
      await files.writeFileAtomically(gitignorePath, 'local\n');
    }
  },

  // This is a WatchSet that ends up being the WatchSet for the app's
  // initFromAppDir PackageSource. Changes to this will cause the whole app to
  // be rebuilt (client and server).
  getProjectWatchSet: function () {
    // We don't cache a projectWatchSet on this object, since some of the
    // metadata files can be written by us (eg .meteor/versions
    // post-constraint-solve).
    var self = this;
    var watchSet = new watch.WatchSet;
    [self.releaseFile, self.projectConstraintsFile, self.packageMapFile,
      self.platformList, self.cordovaPluginsFile].forEach(
      function (metadataFile) {
        metadataFile && watchSet.merge(metadataFile.watchSet);
    });

    if (self.localCatalog) {
      watchSet.merge(self.localCatalog.packageLocationWatchSet);
    }

    return watchSet;
  },

  // This WatchSet encompasses everything that users can change to restart an
  // app. We only watch this for failed bundles; for successful bundles, we have
  // more precise server-specific and client-specific WatchSets that add up to
  // this one.
  getProjectAndLocalPackagesWatchSet: function () {
    var self = this;
    var watchSet = self.getProjectWatchSet();

    // Include the loaded local packages (ie, the non-metadata files) but only
    // if we've actually gotten to the buildLocalPackages step.
    if (self.isopackCache) {
      watchSet.merge(self.isopackCache.allLoadedLocalPackagesWatchSet);
    }
    return watchSet;
  },

  getLintingMessagesForLocalPackages: function () {
    var self = this;
    return self.isopackCache.getLintingMessagesForLocalPackages();
  },

  _ensureAppIdentifier: async function () {
    var self = this;
    var identifierFile = files.pathJoin(self.projectDir, '.meteor', '.id');

    // Find the first non-empty line, ignoring comments. We intentionally don't
    // put this in a WatchSet, since changing this doesn't affect the built app
    // much (and there's no real reason to update it anyway).
    var lines = files.getLinesOrEmpty(identifierFile);
    var appId = _.find(_.map(lines, files.trimSpaceAndComments), _.identity);

    // If the file doesn't exist or has no non-empty lines, regenerate the
    // token.
    if (!appId) {
      appId = [
        utils.randomIdentifier(),
        utils.randomIdentifier()
      ].join(".");

      var comment = (
"# This file contains a token that is unique to your project.\n" +
"# Check it into your repository along with the rest of this directory.\n" +
"# It can be used for purposes such as:\n" +
"#   - ensuring you don't accidentally deploy one app on top of another\n" +
"#   - providing package authors with aggregated statistics\n" +
"\n");
      await files.writeFileAtomically(identifierFile, comment + appId + '\n');
    }

    self.appIdentifier = appId;
  },

  _resolveConstraints: Profile('_resolveConstraints', async function () {
    var self = this;
    buildmessage.assertInJob();
    var depsAndConstraints = await self._getRootDepsAndConstraints();
    // If this is in the runner and we have reset this ProjectContext for a
    // rebuild, use the versions we calculated last time in this process (which
    // may not have been written to disk if our release doesn't match the
    // project's release on disk)... unless the actual file on disk has changed
    // out from under us. Otherwise use the versions from .meteor/versions.
    var cachedVersions;
    if (self._cachedVersionsBeforeReset &&
        self._oldPackageMapFileHash === self.packageMapFile.fileHash) {
      // The file on disk hasn't change; reuse last time's results.
      cachedVersions = self._cachedVersionsBeforeReset;
    } else {
      // We don't have a last time, or the file has changed; use
      // .meteor/versions.
      cachedVersions = self.packageMapFile.getCachedVersions();
    }

    var anticipatedPrereleases = self._getAnticipatedPrereleases(
      depsAndConstraints.constraints, cachedVersions);

    if (self.explicitlyAddedPackageNames.length) {
      cachedVersions = _.clone(cachedVersions);
      self.explicitlyAddedPackageNames.forEach(function (p) {
        delete cachedVersions[p];
      });
    }

    var resolverRunCount = 0;

    // Nothing before this point looked in the official or project catalog!
    // However, the resolver does, so it gets run in the retry context.
    await catalog.runAndRetryWithRefreshIfHelpful(function (canRetry) {
      return buildmessage.enterJob("selecting package versions", async function () {
        var resolver = await self._buildResolver();

        var resolveOptions = {
          previousSolution: cachedVersions,
          anticipatedPrereleases: anticipatedPrereleases,
          allowIncompatibleUpdate: self._allowIncompatibleUpdate,
          // Not finding an exact match for a previous version in the catalog
          // is considered an error if we haven't refreshed yet, and will
          // trigger a refresh and another attempt.  That way, if a previous
          // version exists, you'll get it, even if we don't have a record
          // of it yet.  It's not actually fatal, though, for previousSolution
          // to refer to package versions that we don't have access to or don't
          // exist.  They'll end up getting changed or removed if possible.
          missingPreviousVersionIsError: canRetry,
          supportedIsobuildFeaturePackages: KNOWN_ISOBUILD_FEATURE_PACKAGES,
        };
        if (self._upgradePackageNames) {
          resolveOptions.upgrade = self._upgradePackageNames;
        }
        if (self._upgradeIndirectDepPatchVersions) {
          resolveOptions.upgradeIndirectDepPatchVersions = true;
        }

        resolverRunCount++;

        var solution;
        try {
          await Profile.time(
            "Select Package Versions" +
              (resolverRunCount > 1 ? (" (Try " + resolverRunCount + ")") : ""),
            async function () {
              solution = await resolver.resolve(
                depsAndConstraints.deps, depsAndConstraints.constraints,
                resolveOptions);
            });
        } catch (e) {
          if (!e.constraintSolverError && !e.versionParserError)
            throw e;
          // If the contraint solver gave us an error, refreshing
          // might help to get new packages (see the comment on
          // missingPreviousVersionIsError above).  If it's a
          // package-version-parser error, print a nice message,
          // but don't bother refreshing.
          buildmessage.error(
            e.message,
            { tags: { refreshCouldHelp: !!e.constraintSolverError }});
        }

        if (buildmessage.jobHasMessages())
          return;

        self.packageMap = new packageMapModule.PackageMap(solution.answer, {
          localCatalog: self.localCatalog
        });

        self.packageMapDelta = new packageMapModule.PackageMapDelta({
          cachedVersions: cachedVersions,
          packageMap: self.packageMap,
          usedRCs: solution.usedRCs,
          neededToUseUnanticipatedPrereleases:
          solution.neededToUseUnanticipatedPrereleases,
          anticipatedPrereleases: anticipatedPrereleases
        });

        await self.packageMapDelta.init();

        await self._saveResolverResultCache();

        self._completedStage = STAGE.RESOLVE_CONSTRAINTS;
      });
    });
  }),

  _readResolverResultCache() {
    if (! this._resolverResultCache) {
      try {
        this._resolverResultCache =
          JSON.parse(files.readFile(files.pathJoin(
            this.projectLocalDir,
            "resolver-result-cache.json"
          )));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        this._resolverResultCache = {};
      }
    }

    return this._resolverResultCache;
  },

  async _saveResolverResultCache() {
    await files.writeFileAtomically(
      files.pathJoin(
        this.projectLocalDir,
        "resolver-result-cache.json"
      ),
      JSON.stringify(this._resolverResultCache) + "\n"
    );
  },

  getBuildCache() {
    try {
      return JSON.parse(files.readFile(files.pathJoin(
        this.projectLocalDir,
        "build-cache.json"
      )));
    } catch (e) {
      return null;
    }
  },

  async saveBuildCache(buildCache) {
    await files.writeFileAtomically(
      files.pathJoin(
        this.projectLocalDir,
        "build-cache.json"
      ),
      JSON.stringify(buildCache) + "\n"
    );
  },

  // When running test-packages for an app with local packages, this
  // method will return the original app dir, as opposed to the temporary
  // testRunnerAppDir created for the tests.
  getOriginalAppDirForTestPackages() {
    const appDir = this._projectDirForLocalPackages;
    if (_.isString(appDir) && appDir !== this.projectDir) {
      return appDir;
    }
  },

  _localPackageSearchDirs: function () {
    const self = this;
    let searchDirs = [
      files.pathJoin(self._projectDirForLocalPackages, 'packages'),
    ];

    // User can provide additional package directories to search in
    // METEOR_PACKAGE_DIRS (semi-colon/colon-separated, depending on OS),

    // PACKAGE_DIRS Deprecated in 2016-10
    // Warn users to migrate from PACKAGE_DIRS to METEOR_PACKAGE_DIRS
    if (process.env.PACKAGE_DIRS) {
      Console.warn('For compatibility, the PACKAGE_DIRS environment variable',
        'is deprecated and will be removed in a future Meteor release.');
      Console.warn('Developers should now use METEOR_PACKAGE_DIRS and',
        'Windows projects should now use a semi-colon (;) to separate paths.');
    }

    function packageDirsFromEnvVar(envVar, delimiter = files.pathOsDelimiter) {
      return process.env[envVar] && process.env[envVar].split(delimiter) || [];
    }

    const envPackageDirs = [
    // METEOR_PACKAGE_DIRS should use the arch-specific delimiter
      ...(packageDirsFromEnvVar('METEOR_PACKAGE_DIRS')),
      // PACKAGE_DIRS (deprecated) always used ':' separator (yes, even Windows)
      ...(packageDirsFromEnvVar('PACKAGE_DIRS', ':')),
    ];

    if (! self._ignorePackageDirsEnvVar && envPackageDirs.length) {
      // path.delimiter was added in v0.9.3
      envPackageDirs.forEach( p => searchDirs.push(files.pathResolve(p)) );
    }

    if (! self._ignoreCheckoutPackages && files.inCheckout()) {
      // Running from a checkout, so use the Meteor core packages from the
      // checkout.
      const packagesDir =
        files.pathJoin(files.getCurrentToolsDir(), 'packages');

      searchDirs.push(
        // Include packages like packages/ecmascript.
        packagesDir,
        // Include packages like packages/non-core/coffeescript.
        files.pathJoin(packagesDir, "non-core"),
        // Include packages like packages/non-core/blaze/packages/blaze.
        files.pathJoin(packagesDir, "non-core", "*", "packages"),
      );
    }
    return searchDirs;
  },

  // Returns a layered catalog with information about the packages that can be
  // used in this project. Processes the package.js file from all local packages
  // but does not compile the packages.
  //
  // Must be run in a buildmessage context. On build error, returns null.
  _initializeCatalog: Profile('_initializeCatalog', async function () {
    var self = this;
    buildmessage.assertInJob();
    await catalog.runAndRetryWithRefreshIfHelpful(async function () {
      return await buildmessage.enterJob(
        "scanning local packages",
        async function () {
          self.localCatalog = new catalogLocal.LocalCatalog();
          self.projectCatalog = new catalog.LayeredCatalog(
            self.localCatalog, self._officialCatalog);

          var searchDirs = self._localPackageSearchDirs();
          await self.localCatalog.initialize({
            localPackageSearchDirs: searchDirs,
            explicitlyAddedLocalPackageDirs: self._explicitlyAddedLocalPackageDirs
          });

          if (buildmessage.jobHasMessages()) {
            // Even if this fails, we want to leave self.localCatalog assigned,
            // so that it gets counted included in the projectWatchSet.
            return;
          }

          self.explicitlyAddedPackageNames = [];
          _.each(self._explicitlyAddedLocalPackageDirs, function (dir) {
            var localVersionRecord =
                  self.localCatalog.getVersionBySourceRoot(dir);
            if (localVersionRecord) {
              self.explicitlyAddedPackageNames.push(localVersionRecord.packageName);
            }
          });

          self._completedStage = STAGE.INITIALIZE_CATALOG;
        }
      );
    });
  }),

  _getRootDepsAndConstraints: async function () {
    const depsAndConstraints = {
      deps: [],
      constraints: [],
    };

    this._addAppConstraints(depsAndConstraints);
    await this._addLocalPackageConstraints(depsAndConstraints);
    this._addReleaseConstraints(depsAndConstraints);

    return depsAndConstraints;
  },

  _addAppConstraints: function (depsAndConstraints) {
    this.projectConstraintsFile.eachConstraint(function (constraint) {
      // Add a dependency ("this package must be used") and a constraint
      // ("... at this version (maybe 'any reasonable')").
      depsAndConstraints.deps.push(constraint.package);
      depsAndConstraints.constraints.push(constraint);
    });
  },

  _addLocalPackageConstraints: async function (depsAndConstraints) {
    var self = this;
    const packageNames = await self.localCatalog.getAllPackageNames();
    packageNames.forEach((packageName) => {
      var versionRecord = self.localCatalog.getLatestVersion(packageName);
      var constraint = utils.parsePackageConstraint(
          packageName + "@=" + versionRecord.version);
      // Add a constraint ("this is the only version available") but no
      // dependency (we don't automatically use all local packages!)
      depsAndConstraints.constraints.push(constraint);
    })
  },

  _addReleaseConstraints: function (depsAndConstraints) {
    var self = this;
    if (! self._releaseForConstraints)
      return;
    _.each(self._releaseForConstraints.packages, function (version, packageName) {
      var constraint = utils.parsePackageConstraint(
        // Note that this used to be an exact name@=version constraint,
        // before #7084 eliminated these constraints completely. They
        // were reinstated in Meteor 1.4.3 as name@version constraints,
        // and further refined to name@~version constraints in 1.5.2.
        packageName + "@~" + version);
      // Add a constraint but no dependency (we don't automatically use
      // all local packages!):
      depsAndConstraints.constraints.push(constraint);
    });
  },

  _getAnticipatedPrereleases: function (rootConstraints, cachedVersions) {
    var self = this;

    var anticipatedPrereleases = {};
    var add = function (packageName, version) {
      if (! /-/.test(version)) {
        return;
      }
      if (! _.has(anticipatedPrereleases, packageName)) {
        anticipatedPrereleases[packageName] = {};
      }
      anticipatedPrereleases[packageName][version] = true;
    };

    // Pre-release versions that are root constraints (in .meteor/packages, in
    // the release, or the version of a local package) are anticipated.
    _.each(rootConstraints, function (constraintObject) {
      _.each(constraintObject.versionConstraint.alternatives, function (alt) {
        var version = alt.versionString;
        version && add(constraintObject.package, version);
      });
    });

    // Pre-release versions we decided to use in the past are anticipated.
    _.each(cachedVersions, function (version, packageName) {
      add(packageName, version);
    });

    return anticipatedPrereleases;
  },

  _buildResolver: async function () {
    const { ConstraintSolver } = await loadIsopackage('constraint-solver');

    return new ConstraintSolver.PackagesResolver(this.projectCatalog, {
      yield() {
        return Console.yield();
      },
      Profile: Profile,
      resultCache: this._resolverResultCache
    });
  },

  _downloadMissingPackages: Profile('_downloadMissingPackages', async function () {
    var self = this;
    buildmessage.assertInJob();
    if (!self.packageMap)
      throw Error("which packages to download?");

    await catalog.runAndRetryWithRefreshIfHelpful(function () {
      return buildmessage.enterJob("downloading missing packages", async function () {
        await self.tropohouse.downloadPackagesMissingFromMap(self.packageMap, {
          serverArchitectures: self._serverArchitectures
        });
        if (buildmessage.jobHasMessages())
          return;
        self._completedStage = STAGE.DOWNLOAD_MISSING_PACKAGES;
      });
    });
  }),

  _buildLocalPackages: Profile('_buildLocalPackages', async function () {
    var self = this;
    buildmessage.assertInCapture();


    await self.packageMap.eachPackage((name, packageInfo) => {
      if (packageInfo.kind === 'local') {
        addWatchRoot(packageInfo.packageSource.sourceRoot)
      }
    });

    self.isopackCache = new isopackCacheModule.IsopackCache({
      packageMap: self.packageMap,
      includeCordovaUnibuild: (self._forceIncludeCordovaUnibuild
                               || self.platformList.usesCordova()),
      cacheDir: self.getProjectLocalDirectory('isopacks'),
      pluginCacheDirRoot: self.getProjectLocalDirectory('plugin-cache'),
      tropohouse: self.tropohouse,
      previousIsopackCache: self._previousIsopackCache,
      lintLocalPackages: self.lintAppAndLocalPackages,
      lintPackageWithSourceRoot: self._lintPackageWithSourceRoot
    });

    if (self._forceRebuildPackages) {
      await self.isopackCache.wipeCachedPackages(
        self._forceRebuildPackages === true
          ? null : self._forceRebuildPackages);
    }

    await buildmessage.enterJob('building local packages', async function () {
      return await self.isopackCache.buildLocalPackages();
    });
    self._completedStage = STAGE.BUILD_LOCAL_PACKAGES;
  }),

  _saveChangedMetadata: Profile('_saveChangedMetadata', async function () {
    var self = this;

    // Save any changes to .meteor/packages.
    if (! self._neverWriteProjectConstraintsFile)
      await self.projectConstraintsFile.writeIfModified();

    // Write .meteor/versions if the command always wants to (create/update),
    // or if the release of the app matches the release of the process.
    if (! self._neverWritePackageMap &&
        (self._alwaysWritePackageMap ||
         (release.current.isCheckout() && self.releaseFile.isCheckout()) ||
         (! release.current.isCheckout() &&
          release.current.name === self.releaseFile.fullReleaseName))) {

      await self.packageMapFile.write(self.packageMap);
    }

    self._completedStage = STAGE.SAVE_CHANGED_METADATA;
  })
});


// Represents .meteor/packages.
exports.ProjectConstraintsFile = function (options) {
  var self = this;
  buildmessage.assertInCapture();

  self.filename = files.pathJoin(options.projectDir, '.meteor', 'packages');
  self.watchSet = null;

  // List of packages that should be included if not provided in .meteor/packages
  self._includePackages = options.includePackages || [];

  // Have we modified the in-memory representation since reading from disk?
  self._modified = null;
  // List of each line in the file; object with keys:
  // - leadingSpace (string of spaces before the constraint)
  // - constraint (as returned by utils.parsePackageConstraint)
  // - trailingSpaceAndComment (string of spaces/comments after the constraint)
  // This allows us to rewrite the file preserving comments.
  self._constraintLines = null;
  // Maps from package name to entry in _constraintLines.
  self._constraintMap = null;
  self._readFile();
};

Object.assign(exports.ProjectConstraintsFile.prototype, {
  _readFile: function () {
    var self = this;
    buildmessage.assertInCapture();

    self.watchSet = new watch.WatchSet;
    self._modified = false;
    self._constraintMap = {};
    self._constraintLines = [];
    var contents = watch.readAndWatchFile(self.watchSet, self.filename);

    // No .meteor/packages? This isn't a very good project directory. In fact,
    // that's the definition of a project directory! (And that should have been
    // fixed by _ensureProjectDir!)
    if (contents === null)
      throw Error("packages file missing: " + self.filename);

    var extraConstraintMap = {};
    _.each(self._includePackages, function (pkg) {
      var lineRecord = {
        constraint: utils.parsePackageConstraint(pkg.trim()),
        skipOnWrite: true
      };
      extraConstraintMap[lineRecord.constraint.package] = lineRecord;
    });

    var lines = files.splitBufferToLines(contents);
    // Don't keep a record for the space at the end of the file.
    if (lines.length && _.last(lines) === '')
      lines.pop();

    _.each(lines, function (line) {
      var lineRecord =
            { leadingSpace: '', constraint: null, trailingSpaceAndComment: '' };
      self._constraintLines.push(lineRecord);
      // Strip comment.
      var match = line.match(/^([^#]*)(#.*)$/);
      if (match) {
        line = match[1];
        lineRecord.trailingSpaceAndComment = match[2];
      }
      // Strip trailing space.
      match = line.match(/^((?:.*\S)?)(\s*)$/);
      line = match[1];
      lineRecord.trailingSpaceAndComment =
        match[2] + lineRecord.trailingSpaceAndComment;
      // Strip leading space.
      match = line.match(/^(\s*)((?:\S.*)?)$/);
      lineRecord.leadingSpace = match[1];
      line = match[2];

      // No constraint? Leave lineRecord.constraint null and continue.
      if (line === '')
        return;
      lineRecord.constraint = utils.parsePackageConstraint(line, {
        useBuildmessage: true,
        buildmessageFile: self.filename
      });
      if (! lineRecord.constraint)
        return;  // recover by ignoring

      // Mark as not iterable if already included in self._includePackages
      if (_.has(extraConstraintMap, lineRecord.constraint.package))
        lineRecord.skipOnRead = true;

      if (_.has(self._constraintMap, lineRecord.constraint.package)) {
        buildmessage.error(
          "Package name appears twice: " + lineRecord.constraint.package, {
            // XXX should this be relative?
            file: self.filename
          });
        return;  // recover by ignoring
      }
      self._constraintMap[lineRecord.constraint.package] = lineRecord;
    });

    Object.keys(extraConstraintMap).forEach(function (key) {
      var lineRecord = extraConstraintMap[key];
      self._constraintLines.push(lineRecord);
      self._constraintMap[lineRecord.constraint.package] = lineRecord;
    });
  },

  writeIfModified: async function () {
    var self = this;
    self._modified && (await self._write());
  },

  _write: async function () {
    var self = this;
    var lines = _.map(self._constraintLines, function (lineRecord) {
      // Don't write packages that were not loaded from .meteor/packages
      if (lineRecord.skipOnWrite)
        return;
      var lineParts = [lineRecord.leadingSpace];
      if (lineRecord.constraint) {
        lineParts.push(lineRecord.constraint.package);
        if (lineRecord.constraint.constraintString) {
          lineParts.push('@', lineRecord.constraint.constraintString);
        }
      }
      lineParts.push(lineRecord.trailingSpaceAndComment, '\n');
      return lineParts.join('');
    });
    await files.writeFileAtomically(self.filename, lines.join(''));
    var messages = await buildmessage.capture(
      { title: 're-reading .meteor/packages' },
      function () {
        return self._readFile();
      });
    // We shouldn't choke on something we just wrote!
    if (messages.hasMessages())
      throw Error("wrote bad .meteor/packages: " + messages.formatMessages());
  },

  // Iterates over all constraints, in the format returned by
  // utils.parsePackageConstraint.
  eachConstraint: function (iterator) {
    var self = this;
    _.each(self._constraintLines, function (lineRecord) {
      if (! lineRecord.skipOnRead && lineRecord.constraint)
        iterator(lineRecord.constraint);
    });
  },

  eachConstraintAsync: async function (iterator){
    const self = this;
    for (const lineRecord of self._constraintLines) {
      if (! lineRecord.skipOnRead && lineRecord.constraint)
        await iterator(lineRecord.constraint);
    }
  },

  // Returns the constraint in the format returned by
  // utils.parsePackageConstraint, or null.
  getConstraint: function (name) {
    var self = this;
    if (_.has(self._constraintMap, name))
      return self._constraintMap[name].constraint;
    return null;
  },

  // Adds constraints, an array of objects as returned from
  // utils.parsePackageConstraint.
  // Does not write to disk immediately; changes are written to disk by
  // writeIfModified() which is called in the _saveChangedMetadata step
  // of project preparation.
  addConstraints: function (constraintsToAdd) {
    var self = this;
    _.each(constraintsToAdd, function (constraintToAdd) {
      if (! constraintToAdd.package) {
        throw new Error("Expected PackageConstraint: " + constraintToAdd);
      }

      var lineRecord;
      if (! _.has(self._constraintMap, constraintToAdd.package)) {
        lineRecord = {
          leadingSpace: '',
          constraint: constraintToAdd,
          trailingSpaceAndComment: ''
        };
        self._constraintLines.push(lineRecord);
        self._constraintMap[constraintToAdd.package] = lineRecord;
        self._modified = true;
        return;
      }
      lineRecord = self._constraintMap[constraintToAdd.package];
      if (_.isEqual(constraintToAdd, lineRecord.constraint))
        return;  // nothing changed
      lineRecord.constraint = constraintToAdd;
      self._modified = true;
    });
  },

  // Like addConstraints, but takes an array of package name strings
  // to add with no version constraint
  addPackages: function (packagesToAdd) {
    this.addConstraints(_.map(packagesToAdd, function (packageName) {
      // make sure packageName is valid (and doesn't, for example,
      // contain an '@' sign)
      utils.validatePackageName(packageName);
      return utils.parsePackageConstraint(packageName);
    }));
  },

  // For every package we already have, update the constraint to be semver>=
  // the constraint from the release
  updateReleaseConstraints: function (releaseRecord) {
    this.addConstraints(
      _.compact(_.map(releaseRecord.packages, (version, packageName) => {
        if (this.getConstraint(packageName)) {
          return utils.parsePackageConstraint(packageName + '@' + version);
        }
      }))
    );
  },

  // The packages in packagesToRemove are expected to actually be in the file;
  // if you want to provide different output for packages in the file vs not,
  // you should have already done that.
  // Does not write to disk immediately; changes are written to disk by
  // writeIfModified() which is called in the _saveChangedMetadata step
  // of project preparation.
  removePackages: function (packagesToRemove) {
    var self = this;
    self._constraintLines = self._constraintLines.filter(
      function (lineRecord) {
        return ! (lineRecord.constraint &&
          packagesToRemove.includes(lineRecord.constraint.package));
      });
    _.each(packagesToRemove, function (p) {
      delete self._constraintMap[p];
    });
    self._modified = true;
  },

  // Removes all constraints. Generally this should only be used in situations
  // where the project is not a real user app: while you can use
  // removeAllPackages followed by addConstraints to fully replace the
  // constraints in a project, this will also lose all user comments and
  // (cosmetic) ordering from the file.
  removeAllPackages: function () {
    var self = this;
    self._constraintLines = [];
    self._constraintMap = {};
    self._modified = true;
  }
});



// Represents .meteor/versions.
exports.PackageMapFile = function (options) {
  var self = this;
  buildmessage.assertInCapture();

  self.filename = options.filename;
  self.watchSet = new watch.WatchSet;
  self.fileHash = null;
  self._versions = {};

  self._readFile();
};

Object.assign(exports.PackageMapFile.prototype, {
  _readFile: function () {
    var self = this;

    var fileInfo = watch.readAndWatchFileWithHash(self.watchSet, self.filename);
    var contents = fileInfo.contents;
    self.fileHash = fileInfo.hash;
    // No .meteor/versions? That's OK, you just get to start your calculation
    // from scratch.
    if (contents === null)
      return;

    buildmessage.assertInCapture();
    var lines = files.splitBufferToLines(contents);
    _.each(lines, function (line) {
      // We don't allow comments here, since it's cruel to allow comments in a
      // file when you're going to overwrite them anyway.
      line = files.trimSpace(line);
      if (line === '')
        return;
      var packageVersion = utils.parsePackageAndVersion(line, {
        useBuildmessage: true,
        buildmessageFile: self.filename
      });
      if (!packageVersion)
        return;  // recover by ignoring

      // If a package appears multiple times in .meteor/versions, we just ignore
      // the second one. This file is more meteor-controlled than
      // .meteor/packages and people shouldn't be surprised to see it
      // automatically fixed.
      if (_.has(self._versions, packageVersion.package))
        return;

      self._versions[packageVersion.package] = packageVersion.version;
    });
  },

  // Note that this is really specific to wanting to know what versions are in
  // the .meteor/versions file on disk, which is a slightly different question
  // from "so, what versions should I be building with?"  Usually you want the
  // PackageMap produced by resolving constraints instead! Returns a map from
  // package name to version.
  getCachedVersions: function () {
    var self = this;
    return _.clone(self._versions);
  },

  write: async function (packageMap) {
    var self = this;
    var newVersions = packageMap.toVersionMap();

    // Only write the file if some version changed. (We don't need to do no-op
    // writes, even if they fix sorting in the file.)
    if (_.isEqual(self._versions, newVersions))
      return;

    self._versions = newVersions;
    var packageNames = Object.keys(self._versions);
    packageNames.sort();
    var lines = [];
    _.each(packageNames, function (packageName) {
      lines.push(packageName + "@" + self._versions[packageName] + "\n");
    });
    var fileContents = Buffer.from(lines.join(''));
    await files.writeFileAtomically(self.filename, fileContents);

    // Replace our watchSet with one for the new contents of the file.
    var hash = watch.sha1(fileContents);
    self.watchSet = new watch.WatchSet;
    self.watchSet.addFile(self.filename, hash);
  }
});



// Represents .meteor/platforms. We take no effort to maintain comments or
// spacing here.
exports.PlatformList = function (options) {
  var self = this;

  self.filename = files.pathJoin(options.projectDir, '.meteor', 'platforms');
  self.watchSet = null;
  self._platforms = null;
};

// These platforms are always present and can be neither added or removed
exports.PlatformList.DEFAULT_PLATFORMS = ['browser', 'server'];

Object.assign(exports.PlatformList.prototype, {
  _init: async function() {
    const self = this;
    await self._readFile();
  },
  _readFile: async function () {
    var self = this;

    // Reset the WatchSet.
    self.watchSet = new watch.WatchSet;
    var contents = watch.readAndWatchFile(self.watchSet, self.filename);

    var platforms = contents ? files.splitBufferToLines(contents) : [];
    // We don't allow comments here, since it's cruel to allow comments in a
    // file when you're going to overwrite them anyway.
    platforms = _.uniq(_.compact(_.map(platforms, files.trimSpace)));
    platforms.sort();

    // Missing some of the default platforms (or the whole file)? Add them and
    // try again.
    if (_.difference(exports.PlatformList.DEFAULT_PLATFORMS,
                     platforms).length) {
      // Write the platforms to disk (automatically adding DEFAULT_PLATFORMS and
      // sorting), which automatically calls this function recursively to
      // re-reads them.
      await self.write(platforms);
      return;
    }

    self._platforms = platforms;
  },

  // Replaces the current platform file with the given list and resets this
  // object (and its WatchSet) to track the new value.
  write: async function (platforms) {
    var self = this;
    self._platforms = null;
    platforms = _.uniq(
      platforms.concat(exports.PlatformList.DEFAULT_PLATFORMS));
    platforms.sort();
    await files.writeFileAtomically(self.filename, platforms.join('\n') + '\n');
    await self._readFile();
  },

  getPlatforms: function () {
    var self = this;
    return _.clone(self._platforms);
  },

  getCordovaPlatforms: function () {
    var self = this;
    return _.difference(self._platforms,
                        exports.PlatformList.DEFAULT_PLATFORMS);
  },

  usesCordova: function () {
    var self = this;
    return ! _.isEmpty(self.getCordovaPlatforms());
  },

  getWebArchs() {
    var self = this;
    var archs = [
      "web.browser",
      "web.browser.legacy",
    ];
    if (self.usesCordova()) {
      archs.push("web.cordova");
    }
    return archs;
  },

  canDelayBuildingArch(arch) {
    return CAN_DELAY_LEGACY_BUILD &&
      arch === "web.browser.legacy";
  }
});


// Represents .meteor/cordova-plugins.
exports.CordovaPluginsFile = function (options) {
  var self = this;
  buildmessage.assertInCapture();

  self.filename = files.pathJoin(options.projectDir, '.meteor', 'cordova-plugins');
  self.watchSet = null;
  // Map from plugin name to version.
  self._plugins = null;
};

Object.assign(exports.CordovaPluginsFile.prototype, {
  init: async function() {
    const self = this;
    await self._readFile();
  },
  _readFile: function () {
    var self = this;
    buildmessage.assertInCapture();

    self.watchSet = new watch.WatchSet;
    self._plugins = {};
    var contents = watch.readAndWatchFile(self.watchSet, self.filename);
    // No file?  No plugins.
    if (contents === null)
      return;

    var lines = files.splitBufferToLines(contents);
    _.each(lines, function (line) {
      line = files.trimSpace(line);
      if (line === '')
        return;

      // We just do a standard split here, not utils.parsePackageConstraint,
      // since cordova plugins don't necessarily obey the same naming
      // conventions as Meteor packages.
      let { id, version } =
        require('./cordova/package-id-version-parser.js').parse(line);
      if (! version) {
        buildmessage.error("Cordova plugin must specify version: " + line, {
          // XXX should this be relative?
          file: self.filename
        });
        return;  // recover by ignoring
      }
      if (_.has(self._plugins, id)) {
        buildmessage.error("Plugin name appears twice: " + id, {
          // XXX should this be relative?
          file: self.filename
        });
        return;  // recover by ignoring
      }
      self._plugins[id] = version;
    });
  },

  getPluginVersions: function () {
    var self = this;
    return _.clone(self._plugins);
  },

  write: async function (plugins) {
    var self = this;
    var pluginNames = Object.keys(plugins);
    pluginNames.sort();
    var lines = _.map(pluginNames, function (pluginName) {
      return pluginName + '@' + plugins[pluginName] + '\n';
    });
    await files.writeFileAtomically(self.filename, lines.join(''));
    var messages = await buildmessage.capture(
      { title: 're-reading .meteor/cordova-plugins' },
      async function () {
        await self._readFile();
      });
    // We shouldn't choke on something we just wrote!
    if (messages.hasMessages())
      throw Error("wrote bad .meteor/packages: " + messages.formatMessages());
  }
});



// Represents .meteor/release.
exports.ReleaseFile = function (options) {
  var self = this;

  self.filename = files.pathJoin(options.projectDir, '.meteor', 'release');
  self.catalog = options.catalog || catalog.official;

  self.watchSet = null;
  // The release name actually written in the file.  Null if no fill.  Empty if
  // the file is empty.
  self.unnormalizedReleaseName = null;
  // The full release name (with METEOR@ if it's missing in
  // unnormalizedReleaseName).
  self.fullReleaseName = null;
  // FOO@bar unless FOO === "METEOR" in which case "Meteor bar".
  self.displayReleaseName = null;
  // Just the track.
  self.releaseTrack = null;
  self.releaseVersion = null;
};

Object.assign(exports.ReleaseFile.prototype, {
  init: async function() {
    const self = this;
    await self._readFile();
  },
  fileMissing: function () {
    var self = this;
    return self.unnormalizedReleaseName === null;
  },
  noReleaseSpecified: function () {
    var self = this;
    return self.unnormalizedReleaseName === '';
  },
  isCheckout: function () {
    var self = this;
    return self.unnormalizedReleaseName === 'none';
  },
  normalReleaseSpecified: function () {
    var self = this;
    return ! (self.fileMissing() || self.noReleaseSpecified()
              || self.isCheckout());
  },

  _readFile: async function () {
    var self = this;

    // Start a new watchSet, in case we just overwrote this.
    self.watchSet = new watch.WatchSet;
    var contents = watch.readAndWatchFile(self.watchSet, self.filename);
    // If file doesn't exist, leave unnormalizedReleaseName empty; fileMissing
    // will be true.
    if (contents === null)
      return;

    var lines = _.compact(_.map(files.splitBufferToLines(contents),
                                files.trimSpaceAndComments));
    // noReleaseSpecified will be true.
    if (!lines.length) {
      self.unnormalizedReleaseName = '';
      return;
    }

    self.unnormalizedReleaseName = lines[0];

    const catalogUtils = require('./packaging/catalog/catalog-utils.js');
    var parts = catalogUtils.splitReleaseName(self.unnormalizedReleaseName);
    self.fullReleaseName = parts[0] + '@' + parts[1];
    self.displayReleaseName = catalogUtils.displayRelease(parts[0], parts[1]);
    self.releaseTrack = parts[0];
    self.releaseVersion = parts[1];

    await self.ensureDevBundleLink();
  },

  // Returns an absolute path to the dev_bundle appropriate for the
  // release specified in the .meteor/release file.
  async getDevBundle() {
    let devBundle = files.getDevBundle();
    const devBundleParts = devBundle.split(files.pathSep);
    const meteorToolIndex = devBundleParts.lastIndexOf("meteor-tool");

    if (meteorToolIndex >= 0) {
      const releaseVersion = await this.catalog.getReleaseVersion(
        this.releaseTrack,
        this.releaseVersion
      );

      if (releaseVersion) {
        const meteorToolVersion = releaseVersion.tool.split("@").pop();
        devBundleParts[meteorToolIndex + 1] = meteorToolVersion;
        devBundle = devBundleParts.join(files.pathSep);
      }
    }

    try {
      return files.realpath(devBundle);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      return null;
    }
  },

  // Make a symlink from .meteor/local/dev_bundle to the actual dev_bundle.
  async ensureDevBundleLink() {
    import { makeLink, readLink } from "./cli/dev-bundle-links.js";

    const dotMeteorDir = files.pathDirname(this.filename);
    const localDir = files.pathJoin(dotMeteorDir, "local");
    const devBundleLink = files.pathJoin(localDir, "dev_bundle");

    if (this.isCheckout()) {
      // Only create .meteor/local/dev_bundle if .meteor/release refers to
      // an actual release, and remove it otherwise.
      await files.rm_recursive(devBundleLink);
      return;
    }

    if (files.inCheckout()) {
      // Never update .meteor/local/dev_bundle to point to a checkout.
      return;
    }

    const newTarget = await this.getDevBundle();
    if (! newTarget) {
      return;
    }

    try {
      const oldOSPath = readLink(devBundleLink);
      const oldTarget = files.convertToStandardPath(oldOSPath);
      if (newTarget === oldTarget) {
        // Don't touch .meteor/local/dev_bundle if it already points to
        // the right target path.
        return;
      }

      files.mkdir_p(localDir);
      makeLink(newTarget, devBundleLink);

    } catch (e) {
      if (e.code !== "ENOENT") {
        // It's ok if the above commands failed because the target path
        // did not exist, but other errors should not be silenced.
        throw e;
      }
    }
  },

  write: async function (releaseName) {
    var self = this;
    await files.writeFileAtomically(self.filename, releaseName + '\n');
    await self._readFile();
  }
});


// Represents .meteor/.finished-upgraders.
// This is only used in a few places, so we don't cache its value in memory;
// we just read it when we need it. There's also no need to add it to a
// watchSet because we don't need to rebuild when it changes.
exports.FinishedUpgraders = function (options) {
  var self = this;

  self.filename = files.pathJoin(
    options.projectDir, '.meteor', '.finished-upgraders');
};

Object.assign(exports.FinishedUpgraders.prototype, {
  readUpgraders: function () {
    var self = this;
    var upgraders = [];
    var lines = files.getLinesOrEmpty(self.filename);
    _.each(lines, function (line) {
      line = files.trimSpaceAndComments(line);
      if (line === '')
        return;
      upgraders.push(line);
    });
    return upgraders;
  },

  appendUpgraders: function (upgraders) {
    var self = this;

    /**
     * @type {string}
     */
    var current = null;
    try {
      current = files.readFile(self.filename, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT')
        throw e;
    }

    var appendText = '';
    if (current === null) {
      // We're creating this file for the first time. Include a helpful comment.
      appendText =
"# This file contains information which helps Meteor properly upgrade your\n" +
"# app when you run 'meteor update'. You should check it into version control\n" +
"# with your project.\n" +
"\n";
    } else if (current.length && current[current.length - 1] !== '\n') {
      // File has an unterminated last line. Let's terminate it.
      appendText = '\n';
    }

    _.each(upgraders, function (upgrader) {
      appendText += upgrader + '\n';
    });

    files.appendFile(self.filename, appendText);
  }
});

export class MeteorConfig {
  constructor({
    appDirectory,
  }) {
    this.appDirectory = appDirectory;
    this.packageJsonPath = files.pathJoin(appDirectory, "package.json");
    this.watchSet = new watch.WatchSet;
    this._resolversByArch = Object.create(null);
  }

  _ensureInitialized() {
    if (! _.has(this, "_config")) {
      const json = optimisticReadJsonOrNull(this.packageJsonPath);
      this._config = json && json.meteor || null;
      this.watchSet.addFile(
          this.packageJsonPath,
          optimisticHashOrNull(this.packageJsonPath)
      );
    }

    const customMeteorConfigClient = process.env.METEOR_CONFIG_CLIENT;
    const customMeteorConfigServer = process.env.METEOR_CONFIG_SERVER;
    const customMeteorConfigTest = process.env.METEOR_CONFIG_TEST;
    const customMeteorConfigTestClient = process.env.METEOR_CONFIG_TEST_CLIENT;
    const customMeteorConfigTestServer = process.env.METEOR_CONFIG_TEST_SERVER;
    this._config =
        customMeteorConfigClient != null ||
        customMeteorConfigServer != null ||
        customMeteorConfigTest != null ||
        customMeteorConfigTestClient != null ||
        customMeteorConfigTestServer != null ? {
          ...this._config || {},
          mainModule: {
            client: process.env.METEOR_CONFIG_CLIENT || this._config.mainModule.client,
            server: process.env.METEOR_CONFIG_SERVER || this._config.mainModule.server,
          },
          ...customMeteorConfigTest && {testModule: customMeteorConfigTest},
          ...((customMeteorConfigTestClient || customMeteorConfigTestServer) && {
            testModule: {
              client: customMeteorConfigTestClient || this._config.testModule.client,
              server: customMeteorConfigTestServer || this._config.testModule.server,
            },
          }),
        } : this._config;

    return this._config;
  }

  // General utility for querying the "meteor" section of package.json.
  // TODO Implement an API for setting these values?
  get(...keys) {
    let config = this._ensureInitialized();
    if (config) {
      keys.every(key => {
        if (config && _.has(config, key)) {
          config = config[key];
          return true;
        }
      });
      return config;
    }
  }

  getNodeModulesToRecompileByArch() {
    const packageNamesByArch = Object.create(null);
    const recompile = this.get("nodeModules", "recompile");

    if (recompile && typeof recompile === "object") {
      const get = arch => packageNamesByArch[arch] || (
        packageNamesByArch[arch] = new Set);

      const addPackage = (name, archs) => {
        archs.forEach(arch => {
          if (arch === 'web') {
            addPackage(
              name,
              ['web.browser', 'web.browser.legacy', 'web.cordova']
            );
          } else {
            get(arch).add(name);
          }
        });
      };

      Object.keys(recompile).forEach(packageName => {
        const info = recompile[packageName];
        if (! info) return;
        if (info === true) {
          addPackage(packageName, ['web', 'os']);
        } else if (typeof info === "string") {
          addPackage(packageName, mapWhereToArches(info));
        } else if (Array.isArray(info)) {
          info.forEach(where => {
            addPackage(packageName, mapWhereToArches(where));
          });
        }
      });
    }

    return packageNamesByArch;
  }

  getNodeModulesToRecompile(
    arch,
    packageNamesByArch = this.getNodeModulesToRecompileByArch(),
  ) {
    return packageNamesByArch[arch];
  }

  // Call this first if you plan to call getMainModule multiple
  // times, so that you can avoid repeating this work each time.
  getMainModulesByArch() {
    return this._getEntryModulesByArch("mainModule");
  }

  // Given an architecture like web.browser, get the best mainModule for
  // that architecture. For example, if this.config.mainModule.client is
  // defined, then because mapWhereToArch("client") === "web", and "web"
  // matches web.browser, return this.config.mainModule.client.
  getMainModule(
    arch,
    mainModulesByArch = this.getMainModulesByArch(),
  ) {
    return this._getEntryModule(arch, mainModulesByArch);
  }

  // Analogous to getMainModulesByArch, except for this.config.testModule.
  getTestModulesByArch() {
    return this._getEntryModulesByArch("testModule");
  }

  // Analogous to getMainModule, except for this.config.testModule.
  getTestModule(
    arch,
    testModulesByArch = this.getTestModulesByArch(),
  ) {
    return this._getEntryModule(arch, testModulesByArch);
  }

  _getEntryModulesByArch(...keys) {
    const configEntryModule = this.get(...keys);
    const entryModulesByArch = Object.create(null);

    if (typeof configEntryModule === "string" ||
        configEntryModule === false) {
      // If the top-level config value is a string or false, use that
      // value as the entry module for all architectures.
      entryModulesByArch["os"] = configEntryModule;
      entryModulesByArch["web"] = configEntryModule;
    } else if (configEntryModule &&
               typeof configEntryModule === "object") {
      // If the top-level config value is an object, use its properties to
      // select an entry module for each architecture.
      Object.keys(configEntryModule).forEach(where => {
        mapWhereToArches(where).forEach(arch => {
          entryModulesByArch[arch] = configEntryModule[where];
        });
      });
    }

    return entryModulesByArch;
  }

  _getEntryModule(
    arch,
    entryModulesByArch,
  ) {
    const entryMatch = archinfo.mostSpecificMatch(
      arch, Object.keys(entryModulesByArch));

    if (entryMatch) {
      const entryModule = entryModulesByArch[entryMatch];

      if (entryModule === false) {
        // If meteor.{main,test}Module.{client,server,...} === false, no
        // modules will be loaded eagerly on the client or server. This is
        // useful if you have an app with no special app/{client,server}
        // directory structure and you want to specify an entry point for
        // just the client (or just the server), without accidentally
        // loading everything on the other architecture. Instead of
        // omitting the entry module for the other architecture, simply
        // set it to false.
        return entryModule;
      }

      if (! this._resolversByArch[arch]) {
        this._resolversByArch[arch] = new Resolver({
          sourceRoot: this.appDirectory,
          targetArch: arch,
        });
      }

      // Use a Resolver to allow the mainModule strings to omit .js or
      // .json file extensions, and to enable resolving directories
      // containing package.json or index.js files.
      const res = this._resolversByArch[arch].resolve(
        // Only relative paths are allowed (not top-level packages).
        "./" + files.pathNormalize(entryModule),
        this.packageJsonPath
      );

      if (res && typeof res === "object") {
        return files.pathRelative(this.appDirectory, res.path);
      }

      buildmessage.error(
        `Could not resolve meteor.mainModule ${
          JSON.stringify(entryModule)
        } in ${
          files.pathRelative(
            this.appDirectory,
            this.packageJsonPath
          )
        } (${arch})`
      );
    }
  }
}
