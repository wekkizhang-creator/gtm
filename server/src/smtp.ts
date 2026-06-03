import net from 'node:net';
import tls from 'node:tls';
import { AppError } from './types';

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  startTls: boolean;
  user: string;
  pass: string;
  from: string;
}

function config(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  if (!host || !from) return null;
  const secure = process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true';
  return {
    host,
    port: Number(process.env.SMTP_PORT ?? (secure ? 465 : 587)),
    secure,
    startTls: process.env.SMTP_STARTTLS === '1' || process.env.SMTP_STARTTLS === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from,
  };
}

function readResponse(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1);
      if (last && /^\d{3}\s/.test(last)) {
        cleanup();
        resolve(buf);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function command(socket: net.Socket, line: string, expected: number[]): Promise<string> {
  socket.write(line + '\r\n');
  const res = await readResponse(socket);
  const code = Number(res.slice(0, 3));
  if (!expected.includes(code)) throw new Error(`SMTP command failed (${line}): ${res.trim()}`);
  return res;
}

async function connect(c: SmtpConfig): Promise<net.Socket> {
  const socket = c.secure
    ? tls.connect({ host: c.host, port: c.port, servername: c.host })
    : net.connect({ host: c.host, port: c.port });
  await new Promise<void>((resolve, reject) => {
    socket.once(c.secure ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });
  const hello = await readResponse(socket);
  if (Number(hello.slice(0, 3)) !== 220) throw new Error(`SMTP connect failed: ${hello.trim()}`);
  return socket;
}

async function maybeStartTls(socket: net.Socket, c: SmtpConfig): Promise<net.Socket> {
  if (c.secure || !c.startTls) return socket;
  await command(socket, `EHLO ${process.env.SMTP_HELO ?? 'localhost'}`, [250]);
  await command(socket, 'STARTTLS', [220]);
  const secureSocket = tls.connect({ socket, servername: c.host });
  await new Promise<void>((resolve, reject) => {
    secureSocket.once('secureConnect', resolve);
    secureSocket.once('error', reject);
  });
  return secureSocket;
}

function encodeAddress(address: string): string {
  return address.replace(/[\r\n<>]/g, '');
}

function buildMessage(from: string, to: string, subject: string, text: string): string {
  return [
    `From: ${encodeAddress(from)}`,
    `To: ${encodeAddress(to)}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
  ]
    .join('\r\n')
    .replace(/\r\n\./g, '\r\n..');
}

export async function sendVerificationEmail(to: string, code: string): Promise<void> {
  const c = config();
  if (!c) {
    throw new AppError(501, 'auth_delivery_not_configured', 'SMTP email delivery is not configured');
  }

  let socket = await connect(c);
  try {
    socket = await maybeStartTls(socket, c);
    await command(socket, `EHLO ${process.env.SMTP_HELO ?? 'localhost'}`, [250]);
    if (c.user || c.pass) {
      const payload = Buffer.from(`\0${c.user}\0${c.pass}`, 'utf8').toString('base64');
      await command(socket, `AUTH PLAIN ${payload}`, [235]);
    }
    await command(socket, `MAIL FROM:<${encodeAddress(c.from)}>`, [250]);
    await command(socket, `RCPT TO:<${encodeAddress(to)}>`, [250, 251]);
    await command(socket, 'DATA', [354]);
    socket.write(
      buildMessage(
        c.from,
        to,
        'Your Efficiency List verification code',
        `Your verification code is ${code}. It expires in 10 minutes.`,
      ) + '\r\n.\r\n',
    );
    const dataRes = await readResponse(socket);
    if (Number(dataRes.slice(0, 3)) !== 250) throw new Error(`SMTP DATA failed: ${dataRes.trim()}`);
    await command(socket, 'QUIT', [221]);
  } finally {
    socket.end();
  }
}
