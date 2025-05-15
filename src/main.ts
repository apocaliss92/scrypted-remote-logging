import sdk, { ScryptedDeviceBase, ScryptedInterface, Setting } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { Transport } from "syslog-client";
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import { Syslog } from "./syslog";
import { getPluginConsole, parseLog, RemoteLogService, RemoteLogServiceEnum } from "./utils";

export default class RemoteBackup extends BasePlugin {
    logService: RemoteLogService;

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
        const remoteGenerator = await getPluginConsole({ pluginId: plugin.pluginId });
        for await (const data of remoteGenerator) {
            if (!data) {
                break;
            }
            const message = String(Buffer.from(data));
            const { message: parsedMessage, severity } = parseLog(message);
            this.logService?.push({
                level: severity,
                message: parsedMessage,
                plugin: plugin.name.replaceAll(' ', '')
            });
            this.getLogger().debug(JSON.stringify({ message, severity, plugin: plugin.name, parsedMessage }));
        }
    }

    async initLogsFetch() {
        const logger = this.getLogger();

        try {
            const { plugins } = this.storageSettings.values;
            logger.log(plugins);

            for (const pluginDeviceId of plugins) {
                const pluginDevice = sdk.systemManager.getDeviceById<ScryptedDeviceBase>(pluginDeviceId);
                logger.log(`Starting logs from ${pluginDevice.pluginId}`);
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