/**
 * @module storj/network/protocol
 */

'use strict';

var assert = require('assert');
var utils = require('../utils');
var Proof = require('../proof');
var Contract = require('../contract');

/**
 * Defines the Storj protocol methods
 * @constructor
 * @param {Object} options
 * @param {Network} options.network
 */
function Protocol(opts) {
  if (!(this instanceof Protocol)) {
    return new Protocol(opts);
  }

  assert(typeof opts === 'object' , 'Invalid options supplied');

  this._network = opts.network;
}

/**
 * Handles OFFER messages
 * @private
 * @param {Object} params
 * @param {Function} callback
 */
Protocol.prototype._handleOffer = function(params, callback) {
  var contract;

  try {
    contract = Contract.fromObject(params.contract);
  } catch (err) {
    return callback(new Error('Invalid contract format'));
  }

  // TODO: Ultimately we will need to create a robust decision engine that will
  // TODO: allow us to better determine if the received offer is in our best
  // TODO: interest. For now, we just make sure that we have the data_shard
  // TODO: from the OFFER and we wish to CONSIGN it.

  // For now, we just accept any storage offer we get that matches our own...
  var self = this;
  var key = contract.get('data_hash');

  if (!self._network._pendingContracts[key]) {
    return callback(new Error('Contract no longer open to offers'));
  }

  if (!self._network._pendingContracts[key]) {
    return callback(new Error('Contract no longer open to offers'));
  }

  if (!contract.verify('farmer', params.contact.nodeID)) {
    return callback(new Error('Invalid signature from farmer'));
  }

  contract.sign('renter', self._network._keypair.getPrivateKey());

  if (!contract._complete()) {
    return callback(new Error('Contract is not complete'));
  }

  if (self._network._pendingContracts[key]) {
    callback(null, { contract: contract.toObject() });
    self._network._pendingContracts[key](params.contact);
    delete self._network._pendingContracts[key];
  } else {
    return callback(new Error('Contract no longer open to offers'));
  }
};

/**
 * Handles AUDIT messages
 * @private
 * @param {Object} params
 * @param {Function} callback
 */
Protocol.prototype._handleAudit = function(params, callback) {
  var self = this;

  self._network._manager.load(params.data_hash, function(err, item) {
    if (err) {
      return callback(err);
    }

    if (!item.shard) {
      return callback(new Error('Shard not found'));
    }

    var proof = new Proof({
      leaves: item.trees[params.contact.nodeID],
      shard: item.shard
    });

    callback(null, { proof: proof.prove(params.challenge) });
  });
};

/**
 * Handles CONSIGN messages
 * @private
 * @param {Object} params
 * @param {Function} callback
 */
Protocol.prototype._handleConsign = function(params, callback) {
  var self = this;

  self._network._manager.load(params.data_hash, function(err, item) {
    if (err) {
      return callback(err);
    }

    var contract = new Contract(item.contracts[params.contact.nodeID]);
    var t = Date.now();

    item.shard = new Buffer(params.data_shard, 'hex');
    item.trees[contract.get('renter_id')] = params.audit_tree;

    try {
      assert(
        item.shard.length <= contract.get('data_size'),
        'Shard size exceeds the contract'
      );
      assert(
        t < contract.get('store_end') || t > contract.get('store_begin'),
        'Consignment violates contract store time'
      );
      assert(
        utils.rmd160sha256(item.shard) === contract.get('data_hash'),
        'Shard hash does not match contract'
      );
    } catch (err) {
      return callback(err);
    }

    self._network._manager.save(item, function(err) {
      if (err) {
        return callback(err);
      }

      callback();
    });
  });
};

/**
 * Handles RETRIEVE messages
 * @private
 * @param {Object} params
 * @param {Function} callback
 */
Protocol.prototype._handleRetrieve = function(params, callback) {
  var self = this;
  var hash = params.data_hash;

  // TODO: We will need to increment the download count to track payments, as
  // TODO: well as make sure that the requester is allowed to fetch the shard
  // TODO: as part of the contract.

  self._network._manager.load(hash, function(err, item) {
    if (err) {
      return callback(err);
    }

    callback(null, { data_shard: item.shard.toString('hex') });
  });
};

/**
 * Returns bound references to the protocol handlers
 */
Protocol.prototype.handlers = function() {
  return {
    OFFER: this._handleOffer.bind(this),
    AUDIT: this._handleAudit.bind(this),
    CONSIGN: this._handleConsign.bind(this),
    RETRIEVE: this._handleRetrieve.bind(this)
  };
};

module.exports = Protocol;