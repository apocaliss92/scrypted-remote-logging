import sdk, { ScryptedDeviceBase, ScryptedInterface, Setting } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { Transport } from "syslog-client";
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import { Syslog } from "./syslog";
import { getPluginConsole, parseLog, RemoteLogService, RemoteLogServiceEnum } from "./utils";
import { Deferred } from "../../scrypted/common/src/deferred";
import { createAsyncQueueFromGenerator } from '../../scrypted/common/src/async-queue';

export default class RemoteBackup extends BasePlugin {
    logService: RemoteLogService;
    stopSignalMap: Record<string, Deferred<void>> = {};
    checkInterval: NodeJS.Timeout;
    pluginLoggerId: Record<string, string> = {};

    storageSettings = new StorageSettings(this, {
        ...getBaseSettings({
            hideHa: true,
            hideMqtt: true,
            onPluginSwitch: async (oldValue, newValue) => {
                await this.startStop(newValue);
            },
        }),
        logService: {
            title: 'Log service',
            type: 'string',
            choices: [RemoteLogServiceEnum.Syslog],
            defaultValue: RemoteLogServiceEnum.Syslog,
            immediate: true,
            onPut: () => this.initLogService()
        },
        plugins: {
            title: 'Plugins',
            type: 'device',
            deviceFilter: `(interfaces.includes('${ScryptedInterface.ScryptedPlugin}'))`,
            multiple: true,
            combobox: true,
            defaultValue: [],
            onPut: async () => await sdk.deviceManager.requestRestart()
        },
        hostname: {
            title: 'Instance hostname',
            type: 'string',
            defaultValue: 'Scrypted',
            placeholder: 'Scrypted',
            onPut: () => this.initLogService()
        },
        // SYSLOG
        syslogAddress: {
            title: 'Server address',
            group: RemoteLogServiceEnum.Syslog,
            type: 'string',
            hide: true,
            placeholder: '192.168.78.12',
            onPut: () => this.initLogService()
        },
        syslogPort: {
            title: 'Port',
            group: RemoteLogServiceEnum.Syslog,
            type: 'number',
            defaultValue: 514,
            placeholder: '514',
            hide: true,
            onPut: () => this.initLogService()
        },
        syslogTransport: {
            title: 'Transport',
            group: RemoteLogServiceEnum.Syslog,
            type: 'string',
            choices: ['TCP', 'UDP'],
            defaultValue: 'TCP',
            hide: true,
            onPut: () => this.initLogService()
        },
        // SYSLOG
    });

    constructor(nativeId: string) {
        super(nativeId, {
            pluginFriendlyName: 'Remote logging',
        });

        const logger = this.getLogger();
        this.startStop(this.storageSettings.values.pluginEnabled).then().catch(logger.log);
    }

    async stopCheckListener() {
        this.checkInterval && clearInterval(this.checkInterval);
        this.checkInterval = undefined;
    }

    // async startPluginsCheckListener() {
    //     this.stopCheckListener();
    //     const logger = this.getLogger();

    //     const { plugins } = this.storageSettings.values;

    //     for (const pluginDeviceId of plugins) {
    //         const logger = await sdk.systemManager.getComponent('logger');
    //         const deviceLogger = await logger.getLogger('device');
    //         this.pluginLoggerId[pluginDeviceId] = await deviceLogger.getLogger(pluginDeviceId);

    //         // const pluginDevice = sdk.systemManager.getDeviceById<ScryptedDeviceBase>(pluginDeviceId);
    //         // sdk.systemManager.listen((deviceId, details, data) => {
    //         //     if (pluginDeviceId === deviceId) {
    //         //         logger.log(details, data);
    //         //     }
    //         // });

    //         // const signal = this.stopSignalMap[pluginDeviceId];
    //         // if (!signal || signal.finished) {
    //         //     logger.log(`Plugin ${pluginDevice.pluginId} was kileld. Try restart`);
    //         //     this.listenPluginLog(pluginDevice).catch(logger.log);
    //         // }
    //     }
    // }

    async startCheckListener() {
        this.stopCheckListener();
        const logger = this.getLogger();

        this.checkInterval = setInterval(async () => {
            const { plugins } = this.storageSettings.values;

            for (const pluginDeviceId of plugins) {
                const pluginDevice = sdk.systemManager.getDeviceById<ScryptedDeviceBase>(pluginDeviceId);

                const signal = this.stopSignalMap[pluginDeviceId];
                if (!signal || signal.finished) {
                    logger.log(`Plugin ${pluginDevice.pluginId} was kileld. Try restart`);
                    this.stopSignalMap[pluginDeviceId] = undefined;
                    this.listenPluginLog(pluginDevice).catch(logger.log);
                }
            }
        }, 2 * 1000);
    }

    async startStop(enabled: boolean) {
        if (enabled) {
            await this.start();
        } else {
            await this.stop();
        }
    }

    async start() {
        if (!this.storageSettings.values.pluginEnabled) {
            this.getLogger().log('Plugin is disabled');

            return;
        }
        await this.stop();

        await this.startCheckListener();
        // await this.startPluginsCheckListener();
        await this.initLogService();
        await this.initLogsFetch();
    }

    async stop() {
        this.logService?.disconnect();
    }

    async getSettings() {
        const logService = this.storageSettings.getItem('logService');
        const allServices = this.storageSettings.settings.logService.choices;

        Object.entries(this.storageSettings.settings).forEach(([_, setting]) => {
            if (setting.group === logService) {
                setting.hide = false;
            } else if (allServices.includes(setting.group)) {
                setting.hide = true;
            }
        })

        const settings: Setting[] = await super.getSettings();

        return settings;
    }

    async listenPluginLog(plugin: ScryptedDeviceBase) {
        const { remoteGenerator } = await getPluginConsole({ pluginId: plugin.pluginId, onClosed: () => this.stopSignalMap[plugin.id].resolve() });
        const logger = this.getLogger();
        const signal = this.stopSignalMap[plugin.id];

        if (signal) {
            signal.resolve();
        }

        this.stopSignalMap[plugin.id] = new Deferred<void>();
        logger.log(`Starting logs from ${plugin.pluginId}`);

        for await (const data of remoteGenerator) {
            const signal = this.stopSignalMap[plugin.id];
            if (!data || signal.finished) {
                logger.log('Plugin closed connection');
                break;
            }
            const message = String(Buffer.from(data));
            const { message: parsedMessage, severity } = parseLog(message);
            this.logService?.push({
                level: severity,
                message: parsedMessage,
                plugin: plugin.name.replaceAll(' ', ''),
                timestamp: new Date()
            });
            logger.debug(JSON.stringify({ message, severity, plugin: plugin.name, parsedMessage }));
        }
    }

    async initLogsFetch() {
        const logger = this.getLogger();

        try {
            const { plugins } = this.storageSettings.values;

            for (const pluginDeviceId of plugins) {
                const pluginDevice = sdk.systemManager.getDeviceById<ScryptedDeviceBase>(pluginDeviceId);
                this.listenPluginLog(pluginDevice).catch(logger.log);
            }
        } catch (e) {
            this.getLogger().log('Error in initLogsFetch', e);
        }
    }

    private async initLogService() {
        try {
            if (this.logService) {
                await this.logService.disconnect();
            }
            const {
                logService,
                syslogAddress,
                syslogPort,
                syslogTransport,
                hostname
            } = this.storageSettings.values;
            if (logService === RemoteLogServiceEnum.Syslog) {

                this.logService = new Syslog(
                    syslogAddress,
                    {
                        port: syslogPort,
                        transport: syslogTransport === 'TCP' ? Transport.Tcp : Transport.Udp,
                        syslogHostname: hostname
                    },
                    this.getLogger()
                );
            }
        } catch (e) {
            this.getLogger().log('Error during service init', e);
        }
    }
}