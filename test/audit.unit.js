'use strict';

const sinon = require('sinon');
const crypto = require('crypto');
const expect = require('chai').expect;
const AuditStream = require('../lib/audit');
const shard = Buffer.from('testshard');


describe('@class AuditStream', function() {

  describe('@constructor', function() {

    it('should create challenges for the specified audits', function() {
      var audit = new AuditStream(24);
      expect(audit._challenges).to.have.lengthOf(24);
    });

  });

  describe('@private _generateChallenge', function() {

    it('should return a random 256 bit challenge', function() {
      var challenge = new AuditStream(6)._generateChallenge();
      expect(challenge).to.have.lengthOf(32);
      expect(Buffer.isBuffer(challenge)).to.equal(true);
    });

  });

  describe('@private _generateTree', function() {

    const sandbox = sinon.sandbox.create();

    afterEach(() => sandbox.restore());

    it('should generate the correct tree', function() {
      const fauxChallenge = new Buffer(new Array(32));
      sandbox.stub(AuditStream.prototype, '_generateChallenge')
        .returns(fauxChallenge);
      const stream = new AuditStream(6);
      stream._generateTree();
      expect(stream._tree._leaves.length).to.equal(8);
      for (let i = 0; i < 8; i++) {
        expect(Buffer.isBuffer(stream._tree._leaves[i])).to.equal(true);
      }
      expect(stream._tree._leaves[0].toString('hex'))
        .to.equal('6017f1105942c0a7da8845b91da6871685fe2927');
    });

  });

  describe('@private _createResponseInput', function() {

    it('should return double hash of data plus hex encoded shard', function() {
      const audit = new AuditStream(6);
      const data = new Buffer('test').toString('hex');
      const response = audit._createResponseInput(data);
      expect(response).to.be.instanceOf(crypto.Hash);
    });

  });

  describe('@method getPublicRecord', function() {

    it('should return the bottom leaves of the merkle tree', function(done) {
      const audit = new AuditStream(12);
      audit.on('finish', function() {
        const leaves = audit.getPublicRecord();
        const branch = audit._tree.level(4).map((i) => i.toString('hex'));
        leaves.forEach(function(leaf) {
          expect(branch.indexOf(leaf)).to.not.equal(-1);
        });
        done();
      });
      audit.write(shard);
      audit.end();
    });

  });

  describe('@method getPrivateRecord', function() {

    it('should return the root, depth, and challenges', function(done) {
      const audit = new AuditStream(12);
      audit.on('finish', function() {
        const secret = audit.getPrivateRecord();
        expect(secret.root).to.equal(audit._tree.root());
        expect(secret.depth).to.equal(audit._tree.levels());
        expect(secret.challenges)
          .to.eql(audit._challenges.map((i) => i.toString('hex')));
        done();
      });
      audit.write(shard);
      audit.end();
    });

  });

  describe('@static fromRecords', function() {

    it('should return same when created from record', function(done) {
      const audit1 = new AuditStream(12);
      audit1.on('finish', function() {
        const tree1 = audit1.getPublicRecord();
        const challenges1 = audit1.getPrivateRecord().challenges;
        const audit2 = AuditStream.fromRecords(challenges1, tree1);
        const tree2 = audit2.getPublicRecord();
        const challenges2 = audit2.getPrivateRecord().challenges;
        challenges2.forEach(function(c, i) {
          expect(c).to.equal(challenges1[i]);
        });
        tree2.forEach(function(l, i) {
          expect(l).to.equal(tree1[i]);
        });
        expect(
          audit1.getPrivateRecord().depth
        ).to.equal(
          audit2.getPrivateRecord().depth
        );
        expect(
          audit1.getPrivateRecord().root
        ).to.eql(
          audit2.getPrivateRecord().root
        );
        done();
      });
      audit1.write(shard);
      audit1.end();
    });

  });

});
