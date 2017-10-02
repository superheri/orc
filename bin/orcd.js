'use strict';

const os = require('os');
const url = require('url');
const async = require('async');
const program = require('commander');
const assert = require('assert');
const bytes = require('bytes');
const hdkey = require('hdkey');
const hibernate = require('kad-hibernate');
const spartacus = require('kad-spartacus');
const onion = require('kad-onion');
const ms = require('ms');
const bunyan = require('bunyan');
const mkdirp = require('mkdirp');
const path = require('path');
const fs = require('fs');
const manifest = require('../package');
const orc = require('../lib');
const options = require('./config');
const { execSync } = require('child_process');
const { Transform } = require('stream');
const config = require('rc')('orc', options);
const boscar = require('boscar');
const kad = require('kad');
const { MongodHelper } = require('mongodb-prebuilt');
const mongodArgs = [
  '--port', config.MongoDBPort,
  '--dbpath', config.MongoDBDataDirectory
];
const mongod = new MongodHelper(mongodArgs);


program.version(`
  orc      ${orc.version.software}
  protocol ${orc.version.protocol}
`);

program.description(`
  Copyright (c) 2017 Counterpoint Hackerspace, Ltd
  Licensed under the GNU Affero General Public License Version 3
`);

program.option('--config <file>', 'path to a orc configuration file');
program.parse(process.argv);

function orctool() {
  return execSync([
    `"${process.execPath}"`, path.join(__dirname, 'orctool.js'), ...arguments
  ].join(' ')).toString().trim();
}

// Extend the Kad T_RESPONSETIMEOUT to 30s because Tor
kad.constants.T_RESPONSETIMEOUT = ms('30s');

// Generate a private extended key if it does not exist
if (!fs.existsSync(config.PrivateExtendedKeyPath)) {
  fs.writeFileSync(
    config.PrivateExtendedKeyPath,
    orctool('generate-key', '--extended')
  );
}

// Generate self-signed ssl certificate if it does not exist
if (!fs.existsSync(config.TransportServiceKeyPath)) {
  let [key, cert] = orctool('generate-cert').split('\r\n\r\n');
  fs.writeFileSync(config.TransportServiceKeyPath, key);
  fs.writeFileSync(config.TransportCertificatePath, cert);
}

// Generate onion service key if it does not exist
if (!fs.existsSync(config.OnionServicePrivateKeyPath)) {
  let key = orctool('generate-onion');
  fs.writeFileSync(config.OnionServicePrivateKeyPath, key);
}

// Generate onion service key if it does not exist
if (!fs.existsSync(config.BridgeOnionServicePrivateKeyPath)) {
  let key = orctool('generate-onion');
  fs.writeFileSync(config.BridgeOnionServicePrivateKeyPath, key);
}

// Generate onion service key if it does not exist
if (!fs.existsSync(config.DirectoryOnionServicePrivateKeyPath)) {
  let key = orctool('generate-onion');
  fs.writeFileSync(config.DirectoryOnionServicePrivateKeyPath, key);
}

// Initialize private extended key
const xprivkey = fs.readFileSync(config.PrivateExtendedKeyPath).toString();
const parentkey = hdkey.fromExtendedKey(xprivkey)
                    .derive(orc.constants.HD_KEY_DERIVATION_PATH);
const childkey = parentkey.deriveChild(parseInt(config.ChildDerivationIndex));
const identity = spartacus.utils.toPublicKeyHash(childkey.publicKey)
                   .toString('hex');

// Create the shards directory if it does not exist
if (!fs.existsSync(path.join(config.ShardStorageBaseDir, 'shards'))) {
  mkdirp.sync(path.join(config.ShardStorageBaseDir, 'shards'));
}

// Initialize logging
const logger = bunyan.createLogger({ name: identity });

// Start mongod before everything else
mongod.run().then((proc) => {
  const mongodShutdown = new MongodHelper(mongodArgs.concat(['--shutdown']));

  init();
  process.on('exit', () => {
    logger.info('exiting, killing mongod');
    mongodShutdown.run().then(() => null, () => null);
  });
}, (err) => {
  // HACK: This will happen when orcd is started from the GUI
  // HACK: The GUI start mongod itself so it can properly terminate it on exit
  if (err.includes('already running') || err.includes('shutting down')) {
    return init();
  }

  logger.error(`failed to start mongod: ${err}`);
  process.exit(1);
});

function init() {
  // Initialize the shard storage database
  const shards = new orc.Shards(
    path.join(config.ShardStorageBaseDir, 'shards'),
    { maxSpaceAllocated: bytes.parse(config.ShardStorageMaxAllocation) }
  );

  // Initialize the storage database
  const database = new orc.Database(
    `mongodb://127.0.0.1:${config.MongoDBPort}/orc-${identity}`
  );

  // Initialize transport adapter with SSL
  const transport = new orc.Transport({
    key: fs.readFileSync(config.TransportServiceKeyPath),
    cert: fs.readFileSync(config.TransportCertificatePath)
  });

  // Initialize public contact data
  const contact = {
    hostname: '127.0.0.1', // NB: Placeholder (kad-onion overrides this)
    protocol: 'https:',
    port: parseInt(config.PublicPort),
    xpub: parentkey.publicExtendedKey,
    index: parseInt(config.ChildDerivationIndex),
    agent: `orc-${manifest.version}/${os.platform()}`
  };

  // Initialize protocol implementation
  const node = new orc.Node({
    database,
    shards,
    logger,
    transport,
    contact,
    privateExtendedKey: xprivkey,
    keyDerivationIndex: parseInt(config.ChildDerivationIndex)
  });

  // Handle any fatal errors
  node.on('error', (err) => {
    logger.error(err.message.toLowerCase());
  });

  const rsaPrivateKey = fs.readFileSync(config.OnionServicePrivateKeyPath)
                          .toString().split('\n')
                          .filter((l) => l && l[0] !== '-')
                          .join('');

  // Establish onion hidden service
  node.plugin(onion({
    rsaPrivateKey,
    torrcEntries: {
      CircuitBuildTimeout: 10,
      KeepalivePeriod: 60,
      NewCircuitPeriod: 60,
      NumEntryGuards: 8
    },
    serviceHealthCheckInterval: ms(config.ServiceAvailabilityCheckInterval)
  }));

  // Intialize control server
  const control = new boscar.Server(node);

  // Plugin bandwidth metering if enabled
  if (!!parseInt(config.BandwidthAccountingEnabled)) {
    node.plugin(hibernate({
      limit: config.BandwidthAccountingMax,
      interval: config.BandwidthAccountingReset,
      reject: ['CLAIM', 'FIND_VALUE', 'STORE', 'CONSIGN']
    }));
  }

  // Use verbose logging if enabled
  if (!!parseInt(config.VerboseLoggingEnabled)) {
    node.rpc.deserializer.append(new Transform({
      transform: (data, enc, callback) => {
        let [rpc, ident] = data;

        if (!ident.payload.params[0] || !ident.payload.params[1]) {
          return callback();
        }

        if (rpc.payload.method) {
          logger.info(
            `received ${rpc.payload.method} (${rpc.payload.id}) from ` +
            `${ident.payload.params[0]} ` +
            `(https://${ident.payload.params[1].hostname}:` +
            `${ident.payload.params[1].port})`
          );
        } else {
          logger.info(
            `received response from ${ident.payload.params[0]} to ` +
            `${rpc.payload.id}`
          );
        }

        callback(null, data);
      },
      objectMode: true
    }));
    node.rpc.serializer.prepend(new Transform({
      transform: (data, enc, callback) => {
        let [rpc, sender, recv] = data;

        if (!recv[0] || !recv[1]) {
          return callback();
        }

        if (rpc.method) {
          logger.info(
            `sending ${rpc.method} (${rpc.id}) to ${recv[0]} ` +
            `(https://${recv[1].hostname}:${recv[1].port})`
          );
        } else {
          logger.info(
            `sending response to ${recv[0]} for ${rpc.id}`
          );
        }

        callback(null, data);
      },
      objectMode: true
    }));
  }

  function announceCapacity(callback = () => null) {
    node.shards.size((err, data) => {
      /* istanbul ignore if */
      if (err) {
        return this.node.logger.warn('failed to measure capacity');
      }

      node.publishCapacityAnnouncement(data, (err) => {
        /* istanbul ignore if */
        if (err) {
          node.logger.error(err.message);
          node.logger.warn('failed to publish capacity announcement');
        } else {
          node.logger.info('published capacity announcement ' +
            `${data.available}/${data.allocated}`
          );
        }
        callback();
      });
    });
  }

  function reapExpiredShards(callback = () => null) {
    const now = Date.now();
    const stale = now -
      (orc.constants.SCORE_INTERVAL + orc.constants.REAPER_GRACE);
    const query = {
      _lastAuditTimestamp: { $lt: stale },
      _lastAccessTimestamp: { $lt: stale  },
      _lastFundingTimestamp: { $lt: stale },
      providerIdentity: identity.toString('hex')
    };

    database.ShardContract.find(query, (err, contracts) => {
      if (err) {
        node.logger.error(`failed to start reaper, reason: ${err.message}`);
        return callback(err);
      }

      async.eachSeries(contracts, (contract, next) => {
        shards.unlink(contract.shardHash, (err) => {
          if (err) {
            node.logger.error(`failed to reap shard ${contract.shardHash}`);
            return next();
          }

          contract.remove(() => next());
        });
      }, callback);
    });
  }

  let retry = null;

  function bootstrapFromLocalProfiles(callback) {
    database.PeerProfile.find({
      updated: { $gt: Date.now() - ms('48HR') },
      identity: { $not: identity.toString('hex') }
    }).sort({ updated: -1 }).limit(10).exec((err, profiles) => {
      if (err) {
        return callback(err);
      }

      profiles
        .map((p) => p.toString())
        .forEach((url) => config.NetworkBootstrapNodes.unshift(url));

      callback();
    });
  }

  function join() {
    let entry = null;

    logger.info(
      `joining network from ${config.NetworkBootstrapNodes.length} seeds`
    );
    async.detectSeries(config.NetworkBootstrapNodes, (seed, done) => {
      logger.info(`requesting identity information from ${seed}`);
      node.identifyService(seed, (err, contact) => {
        if (err) {
          logger.error(`failed to identify seed ${seed} (${err.message})`);
          done(null, false);
        } else {
          entry = contact;
          node.join(contact, (err) => {
            done(null, (err ? false : true) && node.router.size > 1);
          });
        }
      });
    }, (err, result) => {
      if (!result) {
        logger.error('failed to join network, will retry in 1 minute');
        retry = setTimeout(() => join(), ms('1m'));
      } else {
        logger.info(
          `connected to network via ${entry[0]} ` +
          `(https://${entry[1].hostname}:${entry[1].port})`
        );
        logger.info(`discovered ${node.router.size} peers from seed`);
        node.logger.info('subscribing to network capacity announcements');
        node.subscribeCapacityAnnouncement((err, rs) => {
          rs.on('data', ([capacity, contact]) => {
            let timestamp = Date.now();

            database.PeerProfile.findOneAndUpdate({ identity: contact[0] }, {
              capacity: {
                allocated: capacity.allocated,
                available: capacity.available,
                timestamp: Date.now()
              },
              contact: contact[1]
            }, { upsert: true }, (err) => {
              if (err) {
                node.logger.error('failed to update capacity profile');
              }
            });
          });
        });
        announceCapacity();
        setInterval(() => announceCapacity(),
                    ms(config.ShardCapacityAnnounceInterval));
        setInterval(() => reapExpiredShards(), ms(config.ShardReaperInterval));
      }
    });
  }

  function startBridge() {
    let opts = {
      stage: config.BridgeTempStagingBaseDir,
      database,
      enableSSL: parseInt(config.BridgeUseSSL),
      serviceKeyPath: config.BridgeServiceKeyPath,
      certificatePath: config.BridgeCertificatePath,
      authorityChains: config.BridgeAuthorityChains,
      control
    };

    if (parseInt(config.BridgeAuthenticationEnabled)) {
      opts.auth = {
        user: config.BridgeAuthenticationUser,
        pass: config.BridgeAuthenticationPassword
      };
    }

    const bridge = new orc.Bridge(node, opts);
    const rsaPrivateKey = fs.readFileSync(
      config.BridgeOnionServicePrivateKeyPath
    ).toString().split('\n').filter((l) => l && l[0] !== '-').join('');

    node.logger.info(
      'establishing local bridge at ' +
      `${config.BridgeHostname}:${config.BridgePort}`
    );
    bridge.listen(parseInt(config.BridgePort), config.BridgeHostname);
    bridge.audit();

    if (parseInt(config.BridgeOnionServiceEnabled)) {
      node.onion.tor.createHiddenService(
        `${config.BridgeHostname}:${config.BridgePort}`,
        {
          virtualPort: 443,
          keyType: 'RSA1024',
          keyBlob: rsaPrivateKey
        },
        (err, result) => {
          if (err) {
            node.logger.error(
              `failed to establish bridge hidden service: ${err.message}`
            );
          } else {
            node.logger.info(
              'bridge hidden service established ' +
              `https://${result.serviceId}.onion:443`
            );
          }
        }
      );
    }

    return bridge;
  }

  function startDirectory() {
    let opts = {
      database,
      enableSSL: !!parseInt(config.DirectoryUseSSL),
      serviceKeyPath: config.DirectoryServiceKeyPath,
      certificatePath: config.DirectoryCertificatePath,
      authorityChains: config.DirectoryAuthorityChains,
      bootstrapService: config.DirectoryBootstrapService
    };

    const directory = new orc.Directory(node, opts);
    const rsaPrivateKey = fs.readFileSync(
      config.DirectoryOnionServicePrivateKeyPath
    ).toString().split('\n').filter((l) => l && l[0] !== '-').join('');

    node.logger.info(
      'establishing public directory server at ' +
      `${config.DirectoryHostname}:${config.DirectoryPort}`
    );
    directory.listen(parseInt(config.DirectoryPort), config.DirectoryHostname);

    if (parseInt(config.DirectoryOnionServiceEnabled)) {
      node.onion.tor.createHiddenService(
        `${config.DirectoryHostname}:${config.DirectoryPort}`,
        {
          virtualPort: 443,
          keyType: 'RSA1024',
          keyBlob: rsaPrivateKey
        },
        (err, result) => {
          if (err) {
            node.logger.error(
              `failed to establish directory hidden service: ${err.message}`
            );
          } else {
            node.logger.info(
              'directory hidden service established ' +
              `https://${result.serviceId}.onion:443`
            );
          }
        }
      );
    }

    if (config.DirectoryBootstrapService) {
      node.logger.info(
        `bootstrapping local directory using ${config.DirectoryBootstrapService}`
      );
      directory.bootstrap(err => {
        if (err) {
          node.logger.warn(`failed to bootstrap directory, ${err.message}`);
        } else {
          node.logger.info('finished bootstrapping directory');
        }

        node.logger.info('scoring orphaned audit reports');
        directory.scoreAndPublishAuditReports((err) => {
          if (err) {
            node.logger.warn(`failed to score reports, ${err.message}`);
          } else {
            node.logger.info('peer scoring routine completed successfully');
          }
        });
      });
    }

    return directory;
  }

  // Keep a record of the contacts we've seen
  node.router.events.on('add', (identity) => {
    let contact = node.router.getContactByNodeId(identity);

    database.PeerProfile.findOneAndUpdate(
      { identity },
      { identity, contact, updated: Date.now() },
      { upsert: true }
    );
  });

  // Update our own peer profile
  database.PeerProfile.findOneAndUpdate(
    { identity: identity.toString('hex') },
    { contact, updated: 0 },
    { upsert: true }
  );

  // Bind to listening port and join the network
  logger.info('bootstrapping tor and establishing hidden service');
  node.listen(parseInt(config.ListenPort), () => {
    let directory, bridge;

    logger.info(`node listening on port ${config.ListenPort}`);

    if (parseInt(config.BridgeEnabled)) {
      bridge = startBridge();
    }

    if (parseInt(config.DirectoryEnabled)) {
      directory = startDirectory();
    }

    if (directory && bridge) {
      bridge.on('auditInternalFinished', () => {
        directory.scoreAndPublishAuditReports(err => {
          if (err) {
            logger.error(err.message);
          } else {
            logger.info('finished peer scoring');
          }
        });
      });
    }

    bootstrapFromLocalProfiles(() => join());
  });

  // Establish control server and wrap node instance
  control.listen(parseInt(config.ControlPort), config.ControlHostname, () => {
    logger.info(
      `control server bound to ${config.ControlHostname}:${config.ControlPort}`
    );
  });
}
