import { createClient, Client, ClientOptions, Severity } from 'syslog-client';
import { RemoteLogService, LogLevel } from "./utils";

const severityMapping: Record<LogLevel, Severity> = {
    [LogLevel.ERROR]: Severity.Error,
    [LogLevel.WARN]: Severity.Warning,
    [LogLevel.NOTICE]: Severity.Notice,
    [LogLevel.INFO]: Severity.Informational,
    [LogLevel.DEBUG]: Severity.Debug
}

export class Syslog implements RemoteLogService {
    private client: Client;

    constructor(
        ip: string,
        connectOptions: ClientOptions,
        public console: Console
    ) {
        console.log(`Creating Syslog connection to ${ip}: ${JSON.stringify(connectOptions)}`);
        this.client = createClient(ip, {
            ...connectOptions,
            rfc3164: false,
        });
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            this.client.close();
        }
    }

    async push(props: { level: LogLevel, plugin: string, message: string, timestamp: Date }) {
        const { message, level, plugin, timestamp } = props;
        const severity = severityMapping[level];
        this.client.log(message, { severity, appName: plugin, timestamp });
    }

}