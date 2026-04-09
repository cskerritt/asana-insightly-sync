function timestamp() {
  return new Date().toISOString();
}

module.exports = {
  info: (msg, data) => console.log(`[${timestamp()}] INFO: ${msg}`, data || ''),
  error: (msg, data) => console.error(`[${timestamp()}] ERROR: ${msg}`, data || ''),
  warn: (msg, data) => console.warn(`[${timestamp()}] WARN: ${msg}`, data || ''),
};
