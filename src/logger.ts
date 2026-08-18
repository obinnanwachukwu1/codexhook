export interface LogFields {
  [key: string]: unknown;
}

export interface LogEntry extends LogFields {
  readonly timestamp: string;
  readonly level: string;
  readonly event: string;
}

export interface LogObserver {
  readonly observe: (entry: LogEntry) => void;
}

export class Logger {
  constructor(
    private readonly sink: NodeJS.WritableStream = process.stderr,
    private readonly observers: ReadonlyArray<LogObserver> = [],
  ) {}

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
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...fields,
    };
    this.sink.write(`${JSON.stringify(entry)}\n`);
    for (const observer of this.observers) {
      try {
        observer.observe(entry);
      } catch {
        // Log observers must never affect delivery or the primary log sink.
      }
    }
  }
}
