// Vitest JSON omits unhandled errors: independently record completion and errors.
const fs = require('node:fs')
module.exports = class PublicationErrorsReporter {
  onTestRunEnd(_modules, errors, reason) {
    const path = process.env.PUBLICATION_ERRORS_REPORT
    if (!path) throw new Error('Publication unhandled-error report path is required')
    fs.writeFileSync(path, JSON.stringify({ reason, unhandledErrors: errors.map(error => ({ name: error.name, message: error.message })) }))
  }
}
