#!/usr/bin/env node
// Keep the outer entry parseable on old Node versions so setup failures are
// actionable before any modern ESM or SQLite module is loaded.
var version = process.versions.node.split('.');
var major = Number(version[0]);
var minor = Number(version[1]);
if (!(major > 22 || (major === 22 && minor >= 13))) {
  process.stderr.write('当前 Node.js ' + process.versions.node + ' 不受支持，请升级到 Node.js 22.13 或更高版本后重试。\n');
  process.exitCode = 1;
} else {
  var load = new Function('url', 'return import(url)');
  var url = require('node:url').pathToFileURL(require('node:path').join(__dirname, 'startup.mjs')).href;
  load(url)
    .then(function (entry) {
      return entry.runCLI(process.argv.slice(2));
    })
    .then(function (code) {
      process.exitCode = code;
    })
    .catch(function () {
      process.stderr.write('启动组件无法加载，请重新安装包含运行产物的完整 AgentLink 安装包。\n');
      process.exitCode = 1;
    });
}
