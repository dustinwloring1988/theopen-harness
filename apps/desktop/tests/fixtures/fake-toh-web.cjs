// Fake toh web backend for desktop shell tests: serve HTTP on the --port argv
// (or exit immediately) so the caller drives the readiness probe.
const portIndex = process.argv.indexOf('--port')
if (process.env.FAKE_TOH_WEB_EXIT_WITHOUT_SERVING === '1') {
  process.exit(Number(process.env.FAKE_TOH_WEB_EXIT_CODE ?? '3'))
}
const port = Number(process.argv[portIndex + 1])
require('node:http').createServer((request, response) => { response.end('ok') }).listen(port, '127.0.0.1')
setInterval(() => {}, 60_000)
