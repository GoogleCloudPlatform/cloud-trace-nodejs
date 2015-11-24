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

var utils = require('@google/cloud-diagnostics-common').utils;
var traceLabels = require('./trace-labels.js');
var pjson = require('../package.json');
var constants = require('./constants.js');
var path = require('path');
var grpc = require('grpc');

/* @const {Array<string>} list of scopes needed to operate with the trace API */
var SCOPES = ['https://www.googleapis.com/auth/trace.append'];
var PROTO_FILE = path.join(__dirname, '..', 'third_party', 'proto', 'google',
  'devtools', 'cloudtrace', 'v1', 'trace.proto');
var traceDefs = new grpc.load(PROTO_FILE).google.devtools.cloudtrace.v1;

var headers = {};
headers[constants.TRACE_AGENT_REQUEST_HEADER] = 1;

/**
 * Creates a basic trace writer.
 * @param {!Logger} logger
 * @constructor
 */
function TraceWriter(logger, config) {
 /** @private */
  this.logger_ = logger;

  /** @private */
  this.config_ = config;

  /** @private {Array<string>} stringified traces to be published */
  this.buffer_ = [];

  this.service = null;

  // Schedule periodic flushing of the buffer, but only if we are able to get
  // the project number (potentially from the network.)
  // TODO(ofrobots): if the agent gets stopped, we need to stop flush interval
  // too.
  var that = this;
  that.getProjectNumber(function(err, project) {
    if (err) { return; } // ignore as index.js takes care of this.
    that.scheduleFlush_(project);
  });
  utils.getApplicationDefaultAuth(SCOPES, function(err, auth) {
    if (err) {
      that.logger_.warn('Failed to authenticate', err);
      // TODO: turn off here
    } else {
      that.auth = auth;
    }
  });
}

/**
 * Ensures that all sub spans of the provided spanData are
 * closed and then queues the span data to be published.
 *
 * @param {SpanData} spanData The trace to be queued.
 */
TraceWriter.prototype.writeSpan = function(spanData) {
  for (var i = 0; i < spanData.trace.spans.length; i++) {
    if (!spanData.trace.spans[i].isClosed()) {
      spanData.trace.spans[i].close();
    }
  }
  if (this.config_.hostname) {
    spanData.addLabel(traceLabels.GCE_HOSTNAME, this.config_.hostname);
  }
  if (this.config_.instanceId) {
    spanData.addLabel(traceLabels.GCE_INSTANCE_ID, this.config_.instanceId);
  }

  var moduleName = this.config_.gae_module_name || this.config_.hostname;
  if (moduleName) {
    spanData.addLabel(traceLabels.GAE_MODULE_NAME, moduleName);
  }
  if (this.config_.gae_module_version) {
    spanData.addLabel(traceLabels.GAE_MODULE_VERSION,
      this.config_.gae_module_version);

    if (this.config_.gae_minor_version) {
      var versionLabel = '';
      if (moduleName !== 'default') {
        versionLabel = moduleName + ':';
      }
      versionLabel += this.config_.gae_module_version + '.' +
          this.config_.gae_minor_version;
      spanData.addLabel(traceLabels.GAE_VERSION, versionLabel);
    }
  }
  spanData.addLabel(traceLabels.AGENT_DATA, 'node ' + pjson.version);
  this.queueTrace_(spanData.trace);
};

/**
 * Buffers the provided trace to be published.
 *
 * @private
 * @param {Trace} trace The trace to be queued.
 */
TraceWriter.prototype.queueTrace_ = function(trace) {
  var that = this;

  that.getProjectNumber(function(err, project) {
    if (err) {
      that.logger_.info('No project number, dropping trace.');
      return; // ignore as index.js takes care of this.
    }

    trace.project_id = project;
    that.buffer_.push(trace);
    that.logger_.debug('queued trace. new size:', that.buffer_.length);

    // Publish soon if the buffer is getting big
    if (that.buffer_.length >= that.config_.bufferSize) {
      that.logger_.info('Flushing: performing periodic flush');
      setImmediate(function() { that.flushBuffer_(project); });
    }
  });
};

/**
 * Flushes the buffer of traces at a regular interval
 * controlled by the flushDelay property of this
 * TraceWriter's config.
 */
TraceWriter.prototype.scheduleFlush_ = function(project) {
  this.logger_.info('Flushing: performing periodic flush');
  this.flushBuffer_(project);

  // Do it again after delay
  setTimeout(this.scheduleFlush_.bind(this, project),
    this.config_.flushDelaySeconds * 1000).unref();
};

/**
 * Serializes the buffered traces to be published asynchronously.
 *
 * @param {number} projectId The id of the project that traces should publish on.
 */
TraceWriter.prototype.flushBuffer_ = function(projectId) {
  if (this.buffer_.length === 0) {
    return;
  }

  if (!this.service) {
    var uri = 'cloudtrace.googleapis.com';
    var channelCreds = grpc.credentials.createSsl();
    var authCreds = grpc.credentials.createFromGoogleCredential(this.auth);
    this.service = new traceDefs.TraceService(uri,
      grpc.credentials.combineChannelCredentials(channelCreds, authCreds), {});
  }

  // Privatize and clear the buffer.
  var buffer = this.buffer_;
  this.buffer_ = [];

  this.publish_(projectId, { traces: buffer });
};

/**
 * Publishes flushed traces to the network.
 *
 * @param {number} projectId The id of the project that traces should publish on.
 * @param {string} buffer The queued traces.
 */
TraceWriter.prototype.publish_ = function(projectId, buffer) {
  var that = this;
  var buf = {
    project_id: '' + projectId,
    traces: buffer
  };
  that.service.patchTraces(buf, function(err, res) {
    if (err) {
      // TODO(ofrobots): If we failed to publish due to a permanent error, stop
      // the agent.
      that.logger_.error('TraceWriter: error: ', err);
    } else {
      that.logger_.info('TraceWriter: published.');
    }
  });
};

/**
 * Returns the project number if it has been cached and attempts to load
 * it from the enviroment or network otherwise.
 *
 * @param {function(?, number):?} callback an (err, result) style callback
 */
TraceWriter.prototype.getProjectNumber = function(callback) {
  var that = this;
  if (that.config_.projectId) {
    callback(null, that.config_.projectId);
    return;
  }

  utils.getProjectNumber(headers, function(err, project) {
    if (err) {
      callback(err);
      return;
    }
    that.logger_.info('Acquired ProjectId from metadata: ' + project);
    that.config_.projectId = project;
    callback(null, project);
  });
};

/**
 * Export TraceWriter.
 * FIXME(ofrobots): TraceWriter should be a singleton. We should export
 * a get function that returns the instance instead.
 */
module.exports = TraceWriter;
