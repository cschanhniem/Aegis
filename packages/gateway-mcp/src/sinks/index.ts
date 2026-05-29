/**
 * Universal Sink layer — fan AEGIS audit / decision / signal / evidence-pack
 * events out to any customer-side destination via a declarative SinkConfig.
 * Built-ins (http, syslog, stdout) cover most SIEMs; the contract lets
 * customers register their own Sink without forking.
 */

export { SinkRuntime } from './runtime';
export type { SinkRuntimeOptions, SinkMetrics } from './runtime';
export { HttpSink } from './built-in/http';
export { SyslogSink } from './built-in/syslog';
export { StdoutSink } from './built-in/stdout';
export { applyMapping } from './template';
