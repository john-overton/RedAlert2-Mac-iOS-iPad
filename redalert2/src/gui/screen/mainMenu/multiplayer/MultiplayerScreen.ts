import { MainMenuScreen } from '@/gui/screen/mainMenu/MainMenuScreen';
import { MainMenuScreenType, ScreenType } from '@/gui/screen/ScreenType';
import { MainMenuRoute } from '@/gui/screen/mainMenu/MainMenuRoute';
import { HtmlView } from '@/gui/jsx/HtmlView';
import { jsx } from '@/gui/jsx/jsx';
import { MusicType } from '@/engine/sound/Music';
import { MapDigest } from '@/engine/MapDigest';
import { MapFile } from '@/data/MapFile';
import { MapPreviewRenderer } from '@/gui/screen/mainMenu/lobby/MapPreviewRenderer';
import { PregameController, PregameMapSelectionResult } from '@/gui/screen/mainMenu/lobby/PregameController';
import { LobbyType, PlayerStatus, SlotOccupation } from '@/gui/screen/mainMenu/lobby/component/viewmodel/lobby';
import { SlotType } from '@/network/gameopt/SlotInfo';
import { ChatHistory } from '@/gui/chat/ChatHistory';
import { ChatRecipientType } from '@/network/chat/ChatMessage';
import { RECIPIENT_ALL, RECIPIENT_TEAM } from '@/network/gservConfig';
import { OBS_TEAM_ID } from '@/game/gameopts/constants';
import { LobbyClient } from '@/network/client/LobbyClient';
import { createMultiplayerIdentity } from '@/network/MultiplayerIdentity';
import type { Session } from '@/network/server/Session';
import { Multiplayer, ConnectionFields } from './Multiplayer';

const RECENT_KEY = 'multiplayer.recentAddresses';
const NAME_KEY = 'multiplayer.playerName';

export class MultiplayerScreen extends MainMenuScreen {
    public title = 'Multiplayer';
    public musicType = MusicType.Intro;
    private form?: any;
    private client?: LobbyClient;
    private pregame: PregameController;
    private busy = false;
    private error?: string;
    private hosting = false;
    private launching = false;
    private addresses: string[] = [];
    private messages: any[] = [];
    private chatHistory = new ChatHistory();
    private checkedMap?: string;
    private validatedMap?: string;
    private validatedMapFile?: any;
    private active = false;
    private generation = 0;
    private fields: ConnectionFields;

    constructor(private rootController: any, private strings: any, private jsxRenderer: any,
        private rules: any, private mapFileLoader: any, private mapList: any,
        private gameModes: any, private localPrefs: any, private messageBoxApi: any,
        _mapDir?: any, private engineType = 'ra2') {
        super();
        this.fields = { playerName: localPrefs.getItem(NAME_KEY) || 'Commander', serverName: 'Red Alert 2 Game', password: '', port: '1620', address: this.recent()[0] || '' };
        this.pregame = new PregameController(strings, rules, mapFileLoader, mapList, gameModes, localPrefs, this.fields.playerName);
    }

    onEnter(): void {
        this.active = true;
        this.controller.toggleMainVideo(false);
        this.render();
        this.controller.showSidebarButtons();
    }

    async onLeave(): Promise<void> {
        this.active = false;
        if (!this.launching) await this.disconnect();
        await this.controller.hideSidebarButtons();
        this.form = undefined;
    }

    async onStack(): Promise<void> {
        this.active = false;
        await this.controller.hideSidebarButtons();
        this.form = undefined;
    }

    onUnstack(selection?: PregameMapSelectionResult): void {
        this.active = true;
        if (selection && this.client?.session) {
            try {
                this.pregame.applyMapSelection(selection);
                this.send('map', { gameOpts: this.pregame.getSnapshot().gameOpts });
            } catch (error) { this.report(error); }
        }
        this.render();
        this.controller.showSidebarButtons();
    }

    private recent(): string[] {
        try {
            const values = JSON.parse(this.localPrefs.getItem(RECENT_KEY) || '[]');
            return Array.isArray(values) ? values.filter(value => typeof value === 'string').slice(0, 5) : [];
        } catch { return []; }
    }

    private report(error: unknown): void {
        this.error = error instanceof Error ? error.message : String(error);
        this.render();
    }

    private send(name: string, args: Record<string, unknown> = {}): void {
        try { this.error = undefined; this.client?.command(name, args); }
        catch (error) { this.report(error); }
    }

    private async connect(host: boolean): Promise<void> {
        if (this.busy || this.client?.session) return;
        if (!this.fields.playerName.trim()) { this.report('Enter a player name.'); return; }
        this.busy = true;
        this.error = undefined;
        const generation = ++this.generation;
        this.render();
        try {
            const identity = await createMultiplayerIdentity(this.engineType);
            if (generation !== this.generation) return;
            let address = this.fields.address.trim();
            if (host) {
                const shell = (window as any).__RA2_SHELL__;
                if (!shell?.hostGame) throw new Error('Hosting requires the Linux desktop app.');
                const port = Number(this.fields.port);
                if (!/^\d+$/.test(this.fields.port) || port < 1 || port > 65535) throw new Error('Enter a port between 1 and 65535.');
                if (!this.pregame.isInitialized()) await this.pregame.initialize();
                if (generation !== this.generation) return;
                this.pregame.updateSelfName(this.fields.playerName.trim());
                const snapshot = this.pregame.getSnapshot();
                // Hosting starts with free seats; commanders may add bots in the lobby.
                snapshot.slotsInfo = snapshot.slotsInfo.map((slot, index) => index === 0 ? slot : { type: index < snapshot.gameOpts.maxSlots ? SlotType.Open : SlotType.Closed });
                snapshot.gameOpts.aiPlayers = snapshot.gameOpts.aiPlayers.map(() => undefined);
                const result = await shell.hostGame({ identity, gameOpts: snapshot.gameOpts, slotsInfo: snapshot.slotsInfo,
                    countryCount: this.rules.getMultiplayerCountries().length,
                    serverName: this.fields.serverName.trim() || 'Red Alert 2 Game', password: this.fields.password, port });
                this.hosting = true;
                if (generation !== this.generation) { await shell.stopHosting(); this.hosting = false; return; }
                this.addresses = result.addresses.map((value: string) => `${value.includes(':') ? `[${value}]` : value}:${result.port}`);
                address = `127.0.0.1:${result.port}`;
            }
            const client = new LobbyClient();
            this.client = client;
            client.onSession.subscribe(this.onSession);
            client.onChat.subscribe(message => {
                const name = client.session?.clients.find(member => member.id === message.clientId)?.name || 'Commander';
                const recipient = typeof message.to === 'number' ? client.session?.clients.find(member => member.id === message.to)?.name || 'Commander' : message.to === 'team' ? RECIPIENT_TEAM : RECIPIENT_ALL;
                this.messages = [...this.messages, { from: name, to: { type: typeof message.to === 'number' ? ChatRecipientType.Whisper : ChatRecipientType.Channel, name: recipient }, text: message.text, time: new Date() }].slice(-180);
                this.render();
            });
            client.onError.subscribe(error => {
                if (client !== this.client) return;
                if (error.code === 'disconnected' || error.code === 'kicked') {
                    void this.disconnect().then(() => this.report(error));
                } else this.report(error);
            });
            client.onStartGame.subscribe(() => {
                const match = client.getMatchSession();
                this.launching = true;
                this.rootController.goToScreen(ScreenType.Game, { create: true, lanLaunch: match.getLaunchDescriptor(),
                    lanMatchSession: match, returnTo: new MainMenuRoute(MainMenuScreenType.Multiplayer, {}) });
            });
            await client.connect(address, { ...identity, type: 'hello', name: this.fields.playerName.trim(), password: this.fields.password });
            if (generation !== this.generation || client !== this.client) { client.close(); return; }
            this.localPrefs.setItem(NAME_KEY, this.fields.playerName.trim());
            if (!host) {
                // Store addresses only: a password-bearing join URL must not enter preferences.
                const recentAddress = address.replace(/\?.*$/, '');
                this.localPrefs.setItem(RECENT_KEY, JSON.stringify([recentAddress, ...this.recent().filter(value => value !== recentAddress)].slice(0, 5)));
            }
        } catch (error) {
            await this.disconnect();
            this.report(error);
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private onSession = (session: Session): void => {
        this.hydrateSession(session);
        this.render();
        void this.checkMap(session);
    };

    private hydrateSession(session: Session): void {
        if (this.validatedMap !== session.gameOpts.mapDigest) {
            this.validatedMap = undefined;
            this.validatedMapFile = undefined;
        }
        // Session updates (including ping and readiness) must retain the verified
        // file: selecting the current map reuses it instead of loading it again.
        this.pregame.hydrate({ gameOpts: session.gameOpts, slotsInfo: session.slots,
            currentMapFile: this.validatedMapFile });
    }

    private async checkMap(session: Session): Promise<void> {
        const digest = session.gameOpts.mapDigest;
        if (this.checkedMap === digest) {
            const self = session.clients.find(member => member.id === this.client?.clientId);
            if (this.validatedMap === digest && self && !self.mapReady) this.send('map_ready', { digest });
            return;
        }
        this.checkedMap = digest;
        this.validatedMap = undefined;
        this.validatedMapFile = undefined;
        const client = this.client;
        try {
            const file = await this.mapFileLoader.load(session.gameOpts.mapName);
            if (client !== this.client || this.checkedMap !== digest) return;
            if (MapDigest.compute(file) !== digest) throw new Error('Your map differs from the host’s map. Import the same map before joining.');
            this.validatedMap = digest;
            this.validatedMapFile = file;
            this.hydrateSession(client!.session!);
            this.send('map_ready', { digest });
            const preview = new MapPreviewRenderer(this.strings).render(new MapFile(file), LobbyType.MultiplayerHost, this.controller.getSidebarPreviewSize());
            if (this.active) {
                this.controller.toggleSidebarPreview(true);
                this.controller.setSidebarPreview(preview);
            }
        } catch (error) {
            if (client !== this.client || this.checkedMap !== digest) return;
            this.report(`Map unavailable: ${error instanceof Error ? error.message : error}. Each player must import the same map; map downloads are not available yet.`);
        }
    }

    private async disconnect(): Promise<void> {
        this.generation++;
        this.client?.onSession.unsubscribe(this.onSession);
        this.client?.close();
        this.client = undefined;
        if (this.hosting) await (window as any).__RA2_SHELL__?.stopHosting?.();
        this.hosting = false;
        this.addresses = [];
        this.messages = [];
        this.checkedMap = undefined;
        this.validatedMap = undefined;
        this.validatedMapFile = undefined;
        this.chatHistory.reset();
        this.controller.setSidebarPreview();
        this.controller.toggleSidebarPreview(false);
    }

    private lobbyProps(session: Session): any {
        const self = session.clients.find(member => member.id === this.client?.clientId);
        const props = this.pregame.createLobbyFormProps({ lobbyType: self?.admin && !self.ready ? LobbyType.MultiplayerHost : LobbyType.MultiplayerGuest,
            activeSlotIndex: self?.slotIndex ?? -1, messages: this.messages, localUsername: self?.name,
            chatHistory: this.chatHistory, channels: [RECIPIENT_ALL, RECIPIENT_TEAM], onSendMessage: (message: any) => {
                const text = typeof message === 'string' ? message : message?.value;
                if (!text?.trim()) return;
                const recipient = message?.recipient;
                let target: 'all' | 'team' | number = recipient?.name === RECIPIENT_TEAM ? 'team' : 'all';
                if (recipient?.type === ChatRecipientType.Whisper) {
                    const member = session.clients.find(member => member.name === recipient.name);
                    if (!member) { this.report('That commander has left the game.'); return; }
                    target = member.id;
                }
                try { this.client?.chat(text.trim(), target); } catch (error) { this.report(error); }
            },
            decoratePlayerSlot: (slot, _info, index) => {
                const member = session.clients.find(value => value.slotIndex === index);
                slot.selectionLocked = Boolean(member);
                if (member) { slot.status = member.ready ? PlayerStatus.Ready : member.admin ? PlayerStatus.Host : PlayerStatus.NotReady; slot.ping = member.ping; }
            },
        });
        // Keep the original RA2 selectors and layout while making the server authoritative.
        for (const [callback, key] of Object.entries({ onToggleShortGame: 'shortGame', onToggleMcvRepacks: 'mcvRepacks',
            onToggleCratesAppear: 'cratesAppear', onToggleSuperWeapons: 'superWeapons', onToggleHostTeams: 'hostTeams',
            onToggleDestroyableBridges: 'destroyableBridges', onToggleMultiEngineer: 'multiEngineer',
            onToggleNoDogEngiKills: 'noDogEngiKills', onToggleBuildOffAlly: 'buildOffAlly', onChangeGameSpeed: 'gameSpeed',
            onChangeCredits: 'credits', onChangeUnitCount: 'unitCount' })) {
            props[callback] = (value: unknown) => this.send('option', { key, value });
        }
        props.onSlotChange = (occupation: SlotOccupation, slotIndex: number, difficulty?: number) => {
            if (session.slots[slotIndex].type === SlotType.Player) return;
            if (occupation === SlotOccupation.Occupied) this.send('slot_bot', { slotIndex, difficulty });
            else this.send(occupation === SlotOccupation.Open ? 'slot_open' : 'slot_close', { slotIndex });
        };
        // Uploaded bot implementations are local assets and cannot be checked/transferred yet.
        for (const key of props.availableAiNames.keys()) if (key.startsWith('Custom')) props.availableAiNames.delete(key);
        props.availablePlayerCountries = props.availablePlayerCountries.filter((name: string) => name !== 'Observer');
        props.observersAllowed = false;
        for (const callback of ['onCountrySelect', 'onColorSelect', 'onStartPosSelect', 'onTeamSelect']) {
            const original = props[callback];
            props[callback] = (value: unknown, slotIndex: number) => {
                try {
                    if (callback === 'onTeamSelect' && value === OBS_TEAM_ID) {
                        this.report('Spectator slots are not available in direct multiplayer yet.');
                        return;
                    }
                    original(value, slotIndex);
                    const opts = this.pregame.getSnapshot().gameOpts;
                    const slot = session.slots[slotIndex];
                    const player = slot.type === SlotType.Ai ? opts.aiPlayers[slotIndex] : opts.humanPlayers.find(player => player.name === slot.name);
                    if (player) this.send('player', { slotIndex, countryId: player.countryId, colorId: player.colorId, startPos: player.startPos, teamId: player.teamId });
                    this.hydrateSession(session);
                } catch (error) { this.report(error); }
            };
        }
        return props;
    }

    private render(): void {
        if (!this.active) return;
        const session = this.client?.session;
        const self = session?.clients.find(member => member.id === this.client?.clientId);
        const canReady = Boolean(self?.mapReady);
        const ready = () => { if (canReady) this.send('state', { ready: !self?.ready }); };
        const props = { fields: this.fields, busy: this.busy, error: this.error, canHost: Boolean((window as any).__RA2_SHELL__?.hostGame),
            lobbyProps: session ? this.lobbyProps(session) : undefined, serverName: session?.serverName, addresses: this.addresses,
            status: session ? `${session.clients.filter(member => member.ready).length}/${session.clients.length} ready` : undefined,
            ready: self?.ready, canReady, recent: this.recent(), onField: (key: keyof ConnectionFields, value: string) => { this.fields = { ...this.fields, [key]: value }; this.render(); },
            managedPlayers: self?.admin && !self.ready ? session?.clients.filter(member => member.id !== self.id) : [],
            onKick: (clientId: number) => this.send('kick', { clientId }), onMakeAdmin: (clientId: number) => this.send('make_admin', { clientId }),
            onHost: () => void this.connect(true), onJoin: () => void this.connect(false), onReady: ready };
        if (this.form) this.form.applyOptions((options: any) => Object.assign(options, props));
        else {
            const [component] = this.jsxRenderer.render(jsx(HtmlView, { width: '100%', height: '100%', innerRef: (ref: any) => this.form = ref, component: Multiplayer, props }));
            this.controller.setMainComponent(component);
        }
        const buttons: any[] = session ? [
            ...(self?.admin ? [{ label: 'Start Game', disabled: !session.clients.every(member => member.ready && member.mapReady) || session.clients.length < 2,
                onClick: () => this.send('startgame') }, { label: 'Change Map', disabled: self.ready, onClick: () => this.controller.pushScreen(MainMenuScreenType.MapSelection,
                    { lobbyType: LobbyType.MultiplayerHost, gameOpts: this.pregame.getGameOpts(), usedSlots: () => this.pregame.getUsedSlots() }) }] : []),
            { label: self?.ready ? 'Cancel Ready' : 'Ready', disabled: !canReady, onClick: ready },
            { label: 'Leave Game', isBottom: true, onClick: async () => { await this.disconnect(); this.error = undefined; this.render(); } },
        ] : [
            { label: 'Create Game', disabled: this.busy || !props.canHost, onClick: props.onHost },
            { label: 'Join Game', disabled: this.busy, onClick: props.onJoin },
            { label: 'QR LAN', disabled: this.busy, tooltip: 'Open the existing QR connection prototype', onClick: () => this.controller.pushScreen(MainMenuScreenType.LanSetup) },
            { label: 'Back', isBottom: true, onClick: () => this.controller.popScreen() },
        ];
        this.controller.setSidebarButtons(buttons, true);
        this.controller.setSidebarMpContent({ text: session ? this.strings.get(this.gameModes.getById(session.gameOpts.gameMode).label) + '\n\n' + session.gameOpts.mapTitle : '' });
    }
}
