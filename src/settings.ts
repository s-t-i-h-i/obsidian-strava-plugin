// ============================================================================
// settings.ts — co plugin zapamiętuje i jak wygląda zakładka ustawień.
//
// Dwa rodzaje ustawień:
//  - te, które wpisuje użytkownik (Client ID, folder, port),
//  - te, które plugin zapisuje sam (tokeny, data ostatniej synchronizacji).
// Wszystko ląduje w pliku data.json wewnątrz folderu pluginu.
// ============================================================================

import { App, PluginSettingTab, Setting } from 'obsidian';
import type StravaSync from './main';

export interface StravaSyncSettings {
	// --- wpisywane ręcznie przez użytkownika ---
	/** Client ID aplikacji ze strony https://www.strava.com/settings/api */
	clientId: string;
	/** Client Secret tej samej aplikacji — trzymany lokalnie, nigdzie nie wysyłany poza Stravę. */
	clientSecret: string;
	/** Folder w skarbcu, w którym powstają notatki. */
	activitiesFolder: string;
	/** Port lokalnego serwera używanego podczas logowania. */
	callbackPort: number;

	// --- uzupełniane automatycznie przez plugin ---
	/** Token dostępu (ważny ~6 h). */
	accessToken: string;
	/** Token odświeżający (długoterminowy). */
	refreshToken: string;
	/** Kiedy wygasa accessToken — sekundy uniksowe. */
	tokenExpiresAt: number;
	/** Imię i nazwisko sportowca — tylko po to, by pokazać "Połączono jako…". */
	athleteName: string;
	/**
	 * Znacznik czasu (sekundy uniksowe) najnowszej zsynchronizowanej aktywności.
	 * Przy kolejnej synchronizacji prosimy Stravę tylko o rzeczy nowsze niż to —
	 * dzięki temu zwykły sync to zazwyczaj jedno zapytanie zamiast kilkunastu.
	 */
	lastSyncAfter: number;
}

/** Wartości startowe — używane przy pierwszym uruchomieniu pluginu. */
export const DEFAULT_SETTINGS: StravaSyncSettings = {
	clientId: '',
	clientSecret: '',
	activitiesFolder: 'Strava',
	callbackPort: 42813,
	accessToken: '',
	refreshToken: '',
	tokenExpiresAt: 0,
	athleteName: '',
	lastSyncAfter: 0,
};

export class StravaSettingTab extends PluginSettingTab {
	plugin: StravaSync;

	constructor(app: App, plugin: StravaSync) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Rysuje całą zakładkę ustawień.
	 * Obsidian wywołuje to za każdym razem, gdy zakładka się otwiera —
	 * my wywołujemy to dodatkowo po zalogowaniu, żeby odświeżyć status.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const settings = this.plugin.settings;
		// "Połączony" znaczy: mamy refresh_token, czyli możemy w każdej chwili
		// wyrobić nowy access_token bez pytania użytkownika.
		const isConnected = settings.refreshToken !== '';

		// --- Sekcja 1: połączenie z kontem -----------------------------------
		new Setting(containerEl).setName('Connection').setHeading();

		// Prosty pasek statusu na górze zakładki.
		new Setting(containerEl)
			.setName('Status')
			.setDesc(
				isConnected
					? `Connected${settings.athleteName ? ` as ${settings.athleteName}` : ''}`
					: 'Not connected',
			)
			.addButton((button) => {
				if (isConnected) {
					button
						.setButtonText('Disconnect')
						.setWarning()
						.onClick(async () => {
							await this.plugin.disconnect();
							// Przerysowujemy zakładkę, żeby status się zmienił.
							this.display();
						});
				} else {
					button
						.setButtonText('Connect to Strava')
						.setCta()
						.onClick(async () => {
							await this.plugin.connectToStrava();
							this.display();
						});
				}
			});

		// Client ID — publiczny identyfikator aplikacji, może być widoczny.
		new Setting(containerEl)
			.setName('Client ID')
			.setDesc('From your Strava API application at strava.com/settings/api.')
			.addText((text) => {
				text
					.setPlaceholder('e.g. 123456')
					.setValue(settings.clientId)
					.onChange(async (value) => {
						settings.clientId = value.trim();
						await this.plugin.saveSettings();
					});
			});

		// Client Secret — traktujemy jak hasło, więc pole typu password.
		new Setting(containerEl)
			.setName('Client secret')
			.setDesc('Kept only on this device. Never share it.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('Enter client secret')
					.setValue(settings.clientSecret)
					.onChange(async (value) => {
						settings.clientSecret = value.trim();
						await this.plugin.saveSettings();
					});
			});

		// Port musi zgadzać się z adresem powrotnym po stronie Stravy,
		// więc od razu pokazujemy gotowy URL do skopiowania.
		new Setting(containerEl)
			.setName('Callback port')
			.setDesc(
				`Local port used during login. Your Strava app must allow the ` +
					`callback domain "localhost".`,
			)
			.addText((text) => {
				text
					.setPlaceholder('42813')
					.setValue(String(settings.callbackPort))
					.onChange(async (value) => {
						const port = Number(value);
						// Porty poniżej 1024 są zarezerwowane dla systemu,
						// powyżej 65535 nie istnieją — pilnujemy zakresu.
						if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
							settings.callbackPort = port;
							await this.plugin.saveSettings();
						}
					});
			});

		// --- Sekcja 2: notatki ------------------------------------------------
		new Setting(containerEl).setName('Notes').setHeading();

		new Setting(containerEl)
			.setName('Activities folder')
			.setDesc('Folder where one note per activity is created.')
			.addText((text) => {
				text
					.setPlaceholder('Strava')
					.setValue(settings.activitiesFolder)
					.onChange(async (value) => {
						settings.activitiesFolder = value.trim() || 'Strava';
						await this.plugin.saveSettings();
					});
			});

		// --- Sekcja 3: synchronizacja ----------------------------------------
		new Setting(containerEl).setName('Sync').setHeading();

		// Zwykły sync: pobiera tylko aktywności nowsze od ostatnio zapisanej.
		new Setting(containerEl)
			.setName('Sync new activities')
			.setDesc(
				settings.lastSyncAfter > 0
					? `Only activities newer than ${new Date(settings.lastSyncAfter * 1000).toLocaleString()}.`
					: 'Nothing synced yet — this will fetch your full history.',
			)
			.addButton((button) => {
				button
					.setButtonText('Sync now')
					.setCta()
					.onClick(async () => {
						await this.plugin.syncActivities(false);
						this.display();
					});
			});

		// Pełny sync: ignoruje znacznik czasu i przechodzi całą historię.
		// Kosztuje najwięcej zapytań, więc jest osobnym, świadomym wyborem.
		new Setting(containerEl)
			.setName('Full sync')
			.setDesc(
				'Re-fetch the entire history and overwrite existing notes. ' +
					'Uses more of your Strava rate limit.',
			)
			.addButton((button) => {
				button.setButtonText('Full sync').onClick(async () => {
					await this.plugin.syncActivities(true);
					this.display();
				});
			});
	}
}
