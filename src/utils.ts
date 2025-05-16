import sdk, { DeviceProvider, StreamService } from "@scrypted/sdk";
import { createAsyncQueue, createAsyncQueueFromGenerator } from '../../scrypted/common/src/async-queue';
import net from 'net';
import { once } from 'events';

export interface RemoteLogService {
    console: Console;

    disconnect(): Promise<void>;
    push(props: { level: LogLevel, plugin: string, message: string, timestamp: Date }): Promise<void>;
}

export enum RemoteLogServiceEnum {
    Syslog = 'Syslog',
}

export enum LogLevel {
    ERROR = 'ERROR',
    WARN = 'WARN',
    NOTICE = 'NOTICE',
    INFO = 'INFO',
    DEBUG = 'DEBUG',
}

export const getPluginConsole = async (props: {
    pluginId: string,
    onClosed: () => void,
}) => {
    const { pluginId, onClosed } = props;

    const dataQueue = createAsyncQueue<Buffer>();
    const hello = Buffer.from('undefined', 'utf8');
    dataQueue.enqueue(hello);

    async function* localGenerator() {
        while (true) {
            const dataBuffers = dataQueue.clear();
            if (dataBuffers.length === 0) {
                const buf = await dataQueue.dequeue();
                if (buf.length)
                    yield buf;
                continue;
            }

            const concat = Buffer.concat(dataBuffers);
            if (concat.length)
                yield concat;
        }
    }

    const localQueue = createAsyncQueueFromGenerator(localGenerator());

    const plugin = sdk.systemManager.getDeviceByName<DeviceProvider>("@scrypted/core");
    const streamSvc = await plugin.getDevice('consoleservice') as StreamService<Buffer | string, Buffer>;
    const streamSvcDirect = await sdk.connectRPCObject(streamSvc);
    const remoteGenerator = await streamSvcDirect.connectStream(localQueue.queue as AsyncGenerator<Buffer | string>, {
        pluginId
    });

    const plugins = await sdk.systemManager.getComponent('plugins');
    const servicePort = await plugins.getRemoteServicePort(pluginId, 'console') as number | [number, string];
    const [port, host] = Array.isArray(servicePort) ? servicePort : [servicePort, undefined];

    const socket = net.connect({
        port,
        host,
    });
    await once(socket, 'connect');

    socket.on('close', onClosed);
    // socket.on('end', () => queue.end());

    return { remoteGenerator };
}

export const parseLog = (lineParent: string) => {
    const line = lineParent.replaceAll('\n', '');
    const cameraRegex = /^(\[.*\]) .*, .* - \[(.*)\]: (.*)$/;
    const matchCamera = line.match(cameraRegex);

    if (matchCamera) {
        const cameraName = matchCamera[1];
        const severity = matchCamera[2] as LogLevel;
        const messageBody = matchCamera[3];

        const message = `[${severity}]: ${cameraName} - ${messageBody}`;

        return { severity, message };
    } else {
        const pluginRegex = /^.*, .* - \[(.*)\]: (.*)$/;
        const matchPlugin = line.match(pluginRegex);

        if (matchPlugin) {
            const severity = matchPlugin[1] as LogLevel;
            const messageBody = matchPlugin[2];

            const message = `[${severity}]: ${messageBody}`;

            return { severity, message };
        }
    }

    return { message: line, severity: LogLevel.NOTICE };
}