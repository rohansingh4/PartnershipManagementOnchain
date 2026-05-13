'use strict';

const Agreement = require('./lib/agreement');

// fabric-shim bootstrap reads module.exports.contracts and starts the gRPC server.
// The array supports multiple contract classes in one chaincode package.
module.exports.contracts = [Agreement];
