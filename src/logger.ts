export interface LogFields {
  [key: string]: unknown;
}

export class Logger {
  constructor(private readonly sink: NodeJS.WritableStream = process.stderr) {}

  info(event: string, fields: LogFields = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write("error", event, fields);
  }

  private write(level: string, event: string, fields: LogFields): void {
    this.sink.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...fields,
      })}\n`,
    );
  }
}
