Package.describe({
  summary: 'Extended and Extensible JSON library',
  version: '1.1.1'
});

Package.onUse(function onUse(api) {
  api.versionsFrom('1.8.1');
  api.use(['ecmascript', 'base64']);
  api.mainModule('ejson.js');
  api.export('EJSON');
});

Package.onTest(function onTest(api) {
  api.use(['ecmascript', 'tinytest', 'mongo']);
  api.use('ejson');
  api.mainModule('ejson_tests.js');
});
