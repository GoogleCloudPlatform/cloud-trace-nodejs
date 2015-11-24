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

if (!process.env.GCLOUD_PROJECT_NUM) {
  console.log('The GCLOUD_PROJECT_NUM environment variable must be set.');
  process.exit(1);
}

var config = { enhancedDatabaseReporting: true, samplingRate: 0 };
var agent = require('../..').start(config).private_();
// We want to disable publishing to avoid conflicts with production.
agent.traceWriter.publish_ = function() {};

var cls = require('../../lib/cls.js');

var assert = require('assert');
var http = require('http');
var fs = require('fs');
var path = require('path');

var FORGIVENESS = 0.2;
var SERVER_WAIT = 200;
var SERVER_PORT = 9042;
var SERVER_RES = '1729';
var SERVER_KEY = fs.readFileSync(path.join(__dirname, 'fixtures', 'key.pem'));
var SERVER_CERT = fs.readFileSync(path.join(__dirname, 'fixtures', 'cert.pem'));

/**
 * Cleans the tracer state between test runs.
 */
function cleanTraces() {
  agent.traceWriter.buffer_ = [];
}

function getTraces() {
  return agent.traceWriter.buffer_;
}

function getMatchingSpan(predicate) {
  var spans = getMatchingSpans(predicate);
  assert.equal(spans.length, 1,
    'predicate did not isolate a single span');
  return spans[0];
}

function getMatchingSpans(predicate) {
  var list = [];
  getTraces().forEach(function(trace) {
    trace.spans.forEach(function(span) {
      if (predicate(span)) {
        list.push(span);
      }
    });
  });
  return list;
}

function timestampDifferenceMillis(ts1, ts2) {
  var m1 = ts1.seconds * 1e3 + ts1.nanos / 1e6;
  var m2 = ts2.seconds * 1e3 + ts2.nanos / 1e6;
  return m1 - m2;
}

/**
 * Verifies that the duration of the span captured
 * by the tracer matching the predicate `predicate`
 * is greater than the expected duration but within the
 * forgiveness factor of it.
 *
 * If no span predicate is supplied, it is assumed that
 * exactly one span has been recorded and the predicate
 * (t -> True) will be used.
 *
 * @param {function(?)=} predicate
 */
function assertDurationCorrect(predicate) {
  // We assume that the tests never care about top level transactions created
  // by the harness itself
  predicate = predicate || function(span) { return span.name !== 'outer'; };
  var span = getMatchingSpan(predicate);
  var duration = timestampDifferenceMillis(span.end_time, span.start_time);
  assert(duration > SERVER_WAIT * (1 - FORGIVENESS),
      'Duration was ' + duration + ', expected ' + SERVER_WAIT);
  assert(duration < SERVER_WAIT * (1 + FORGIVENESS),
      'Duration was ' + duration + ', expected ' + SERVER_WAIT);
}

function doRequest(method, done, tracePredicate, path) {
  http.get({port: SERVER_PORT, method: method, path: path || '/'}, function(res) {
    var result = '';
    res.on('data', function(data) { result += data; });
    res.on('end', function() {
      assert.equal(SERVER_RES, result);
      assertDurationCorrect(tracePredicate);
      done();
    });
  });
}

function runInTransaction(fn) {
  cls.getNamespace().run(function() {
    var spanData = agent.createRootSpanData('outer');
    fn(function() {
      spanData.close();
    });
  });
}

module.exports = {
  assertDurationCorrect: assertDurationCorrect,
  cleanTraces: cleanTraces,
  getMatchingSpan: getMatchingSpan,
  getMatchingSpans: getMatchingSpans,
  doRequest: doRequest,
  getTraces: getTraces,
  runInTransaction: runInTransaction,
  serverWait: SERVER_WAIT,
  serverRes: SERVER_RES,
  serverPort: SERVER_PORT,
  serverKey: SERVER_KEY,
  serverCert: SERVER_CERT
};
