// Minimal typing for the parts of `smtp-server` used by the TLS relay test.
declare module 'smtp-server' {
  import type { Server } from 'node:net';
  export interface SMTPServerOptions {
    secure?: boolean;
    key?: string | Buffer;
    cert?: string | Buffer;
    authOptional?: boolean;
    allowInsecureAuth?: boolean;
    hideSTARTTLS?: boolean;
    disabledCommands?: string[];
    logger?: boolean;
    onAuth?: (
      auth: { username?: string; password?: string },
      session: unknown,
      cb: (err: Error | null, res?: { user: string }) => void,
    ) => void;
    onData?: (
      stream: NodeJS.ReadableStream,
      session: { envelope: { rcptTo: Array<{ address: string }> } },
      cb: (err?: Error | null) => void,
    ) => void;
  }
  export class SMTPServer {
    constructor(options: SMTPServerOptions);
    server: Server;
    listen(port: number, host: string, cb?: () => void): void;
    close(cb?: () => void): void;
  }
}
