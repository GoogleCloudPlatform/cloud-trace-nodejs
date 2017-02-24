/**
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var assert = require('assert');
var Module = require('module');
var semver = require('semver');
var util = require('../src/util.js');
var path = require('path');

describe('util.packageNameFromPath', function() {
  it('should work for standard packages', function() {
    var p = path.join('.',
               'appengine-sails',
               'node_modules',
               'testmodule',
               'index.js');
    assert.equal(util.packageNameFromPath(p),
      'testmodule');
  });

  it('should work for namespaced packages', function() {
    var p = path.join('.',
               'appengine-sails',
               'node_modules',
               '@google',
               'cloud-trace',
               'index.js');
    assert.equal(util.packageNameFromPath(p),
      path.join('@google','cloud-trace'));
  });
});

describe('util.findModuleVersion', function() {
  it('should correctly find package.json for userspace packages', function() {
    var pjson = require('../package.json');
    var modulePath = util.findModulePath('glob', module);
    assert(semver.satisfies(util.findModuleVersion(modulePath, Module._load),
        pjson.devDependencies.glob));
  });

  it('should not break for core packages', function() {
    var modulePath = util.findModulePath('http', module);
    assert.equal(util.findModuleVersion(modulePath, Module._load), process.version);
  });

  it('should work with namespaces', function() {
    var modulePath = util.findModulePath('@google-cloud/common', module);
    var truePackage =
      require('../node_modules/@google-cloud/common/package.json');
    assert.equal(util.findModuleVersion(modulePath, Module._load), truePackage.version);
  });
});
