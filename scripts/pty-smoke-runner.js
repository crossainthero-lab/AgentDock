const path = require('node:path')
const { runUnderElectron } = require('./electron-node-runner')

runUnderElectron(path.join(__dirname, 'pty-smoke-test.js'))
