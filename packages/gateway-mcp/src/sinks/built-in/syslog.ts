/**
 * Syslog sink — RFC5424 format over TCP or UDP. Covers the long tail of
 * on-prem SIEMs and enterprise log collectors (QRadar, ArcSight, Graylog,
 * rsyslog, etc.) that prefer syslog to HTTP webhooks.
 *
 * Minimal v1: one connection per attempt (no keep-alive pool). At enterprise
 * volumes a pool will matter, but at v1 throughputs the connect-cost is
 * dominated by network RTT and isolation is cleaner.
 */

import {
  SyslogSinkConfig,
  Sink,
  SinkEvent,
  SinkSendResult,
} from '@agentguard/core-schema';
import { applyMapping } from '../template';
import * as net from 'net';
import * as dgram from 'dgram';
import * as os from 'os';

export class SyslogSink implements Sink {
  readonly name: string;
  readonly kind = 'syslog' as const;

  constructor(private cfg: SyslogSinkConfig) {
    this.name = cfg.name;
  }

  async send(event: SinkEvent): Promise<SinkSendResult> {
    const start = Date.now();
    const message = JSON.stringify(applyMapping(event, this.cfg.fieldMapping));
    const frame = formatRfc5424(this.cfg, event, message);

    let lastErr: string | undefined;
    const maxAttempts = this.cfg.retry.maxAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (this.cfg.protocol === 'tcp') await sendTcp(this.cfg, frame);
        else                              await sendUdp(this.cfg, frame);
        return { ok: true, attempts: attempt, durationMs: Date.now() - start };
      } catch (err) {
        lastErr = (err as Error).message ?? 'syslog send failed';
      }
      if (attempt < maxAttempts) {
        await sleep(this.cfg.retry.backoffMs * Math.pow(this.cfg.retry.factor, attempt - 1));
      }
    }
    return { ok: false, attempts: maxAttempts, error: lastErr, durationMs: Date.now() - start };
  }
}

function formatRfc5424(cfg: SyslogSinkConfig, event: SinkEvent, msg: string): string {
  const severity = event.kind === 'audit' ? 6 : 5;   // info | notice
  const pri = cfg.facility * 8 + severity;
  const host = os.hostname();
  const procId = String(process.pid);
  const msgId = event.kind;
  // RFC5424: <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [STRUCTURED-DATA] MSG
  return `<${pri}>1 ${event.timestamp} ${host} ${cfg.appName} ${procId} ${msgId} - ${msg}\n`;
}

function sendTcp(cfg: SyslogSinkConfig, frame: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: cfg.host, port: cfg.port, timeout: cfg.timeoutMs });
    sock.once('error', err => { sock.destroy(); reject(err); });
    sock.once('timeout', () => { sock.destroy(); reject(new Error('tcp timeout')); });
    sock.write(frame, 'utf8', err => {
      if (err) { sock.destroy(); reject(err); return; }
      sock.end(() => resolve());
    });
  });
}

function sendUdp(cfg: SyslogSinkConfig, frame: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); reject(new Error('udp timeout')); }, cfg.timeoutMs);
    sock.send(frame, cfg.port, cfg.host, err => {
      clearTimeout(timer);
      sock.close();
      if (err) reject(err); else resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
