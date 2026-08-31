import { handleParseWorkerRequest } from '@bosshunter/ingest'

const utilityPort = process.parentPort
if (utilityPort === null || utilityPort === undefined) {
  throw new Error('The ingestion parser must run inside an Electron utility process')
}

utilityPort.once('message', (event) => {
  void handleParseWorkerRequest(event.data).then((response) => {
    utilityPort.postMessage(response)
  })
})
