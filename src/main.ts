// ============================================================================
// main.ts — serce pluginu: cykl życia, komendy i przebieg synchronizacji.
//
// Obsidian ładuje ten plik i wywołuje `onload()` przy włączeniu pluginu
// oraz `onunload()` przy wyłączeniu. Reszta plików (oauth, stravaApi, format)
// zajmuje się szczegółami; tutaj tylko spinamy je w całość.
// ============================================================================

import { Notice, Plugin, TFile, normalizePath } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	StravaSettingTab,
	type StravaSyncSettings,
} from './settings';
import { authorizeWithStrava, cancelAuthorization } from './oauth';
import {
	PER_PAGE,
	StravaAuthError,
	StravaRateLimitError,
	fetchActivitiesPage,
	refreshAccessToken,
} from './stravaApi';
import { formatActivity } from './format';
import { isSkippedActivity } from './filter';
import type { StravaActivity, StravaRateLimit } from './types';

/**
 * Przerwa między kolejnymi stronami wyników (w milisekundach).
 * Strava nie wymaga odstępów, ale kilkaset milisekund to tani sposób,
 * żeby nie wystrzelić serii zapytań w ułamku sekundy.
 */
const PAGE_DELAY_MS = 300;

/**
 * Zapas zapytań, którego nie ruszamy w 15-minutowym okienku.
 * Gdy zostanie ich mniej, przerywamy pobieranie — dzięki temu inne
 * narzędzia (albo ponowna próba) mają jeszcze z czego korzystać,
 * a my nie dostajemy twardego błędu 429.
 */
const RATE_LIMIT_RESERVE = 5;

/**
 * Ile sekund przed wygaśnięciem tokenu odświeżamy go "na zapas".
 * Bez tego zapasu token mógłby wygasnąć w trakcie długiej synchronizacji.
 */
const TOKEN_REFRESH_MARGIN = 300;

/** Prosta pauza: `await sleep(300)` zatrzymuje wykonanie na 300 ms. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default class StravaSync extends Plugin {
	settings!: StravaSyncSettings;

	/** Blokada, żeby dwa synchronizacje nie ruszyły naraz (np. komenda + przycisk). */
	private isSyncing = false;

	async onload() {
		await this.loadSettings();

		// Komenda 1: logowanie. Dostępna z palety komend (Ctrl/Cmd + P).
		this.addCommand({
			id: 'connect-to-strava',
			name: 'Connect to Strava',
			callback: async () => {
				await this.connectToStrava();
			},
		});

		// Komenda 2: synchronizacja przyrostowa (tylko nowe aktywności).
		this.addCommand({
			id: 'sync-activities',
			name: 'Sync activities',
			callback: async () => {
				await this.syncActivities(false);
			},
		});

		// Zakładka w Ustawienia → Strava sync.
		this.addSettingTab(new StravaSettingTab(this.app, this));
	}

	onunload() {
		// Jeśli akurat trwało logowanie, zamykamy lokalny serwer,
		// żeby nie zostawiać zajętego portu.
		cancelAuthorization();
	}

	// ------------------------------------------------------------------
	// LOGOWANIE
	// ------------------------------------------------------------------

	/**
	 * Uruchamia logowanie OAuth i zapisuje otrzymane tokeny.
	 * Cała mechanika (serwer lokalny, `state`, wymiana kodu) siedzi w oauth.ts.
	 */
	async connectToStrava(): Promise<void> {
		const { clientId, clientSecret, callbackPort } = this.settings;

		// Bez tych dwóch wartości Strava nie wie, która aplikacja pyta.
		if (!clientId || !clientSecret) {
			new Notice(
				'Najpierw uzupełnij Client ID i Client secret w ustawieniach pluginu.',
			);
			return;
		}

		try {
			const tokens = await authorizeWithStrava(
				clientId,
				clientSecret,
				callbackPort,
				(authorizeUrl) => {
					// Callback wywoływany, gdy lokalny serwer już nasłuchuje.
					// window.open z adresem http otwiera domyślną przeglądarkę.
					new Notice('Otwieram stronę Stravy w przeglądarce…');
					window.open(authorizeUrl, '_blank');
				},
			);

			// Zapisujemy komplet tokenów.
			this.settings.accessToken = tokens.access_token;
			this.settings.refreshToken = tokens.refresh_token;
			this.settings.tokenExpiresAt = tokens.expires_at;

			// Imię i nazwisko przychodzi tylko przy pierwszym logowaniu —
			// zapisujemy je wyłącznie po to, by ładnie pokazać status.
			if (tokens.athlete) {
				this.settings.athleteName =
					`${tokens.athlete.firstname} ${tokens.athlete.lastname}`.trim();
			}

			await this.saveSettings();
			new Notice('Połączono ze Stravą.');
		} catch (error: unknown) {
			new Notice(`Logowanie nieudane: ${(error as Error).message}`);
			console.error(error);
		}
	}

	/** Czyści zapisane tokeny — konto zostaje odłączone od pluginu. */
	async disconnect(): Promise<void> {
		this.settings.accessToken = '';
		this.settings.refreshToken = '';
		this.settings.tokenExpiresAt = 0;
		this.settings.athleteName = '';
		await this.saveSettings();
		new Notice('Odłączono konto Stravy.');
	}

	/**
	 * Zwraca ważny access_token, odświeżając go w razie potrzeby.
	 *
	 * Token ze Stravy żyje około 6 godzin. Zamiast odświeżać go przy każdej
	 * synchronizacji (jedno zapytanie w plecy), sprawdzamy zapisany czas
	 * wygaśnięcia i wołamy Stravę tylko wtedy, gdy naprawdę trzeba.
	 */
	private async ensureFreshToken(): Promise<string> {
		const { accessToken, refreshToken, tokenExpiresAt } = this.settings;

		if (!refreshToken) {
			throw new StravaAuthError(
				'Brak połączenia ze Stravą. Kliknij "Connect to Strava" w ustawieniach.',
			);
		}

		// Date.now() daje milisekundy, a Strava operuje na sekundach.
		const now = Math.floor(Date.now() / 1000);
		if (accessToken && tokenExpiresAt - now > TOKEN_REFRESH_MARGIN) {
			return accessToken;
		}

		const tokens = await refreshAccessToken(
			this.settings.clientId,
			this.settings.clientSecret,
			refreshToken,
		);

		// UWAGA: Strava potrafi przy odświeżeniu wydać NOWY refresh_token.
		// Trzeba zapisać oba, inaczej następne odświeżenie się nie uda.
		this.settings.accessToken = tokens.access_token;
		this.settings.refreshToken = tokens.refresh_token;
		this.settings.tokenExpiresAt = tokens.expires_at;
		await this.saveSettings();

		return tokens.access_token;
	}

	// ------------------------------------------------------------------
	// SYNCHRONIZACJA
	// ------------------------------------------------------------------

	/**
	 * Pobiera aktywności ze Stravy i tworzy dla każdej osobną notatkę.
	 *
	 * @param fullSync
	 *   false — tryb przyrostowy: pytamy tylko o aktywności nowsze niż ostatnio
	 *           zapisana. To domyślny i najtańszy tryb (zwykle 1 zapytanie).
	 *   true  — tryb pełny: przechodzimy całą historię od zera.
	 */
	async syncActivities(fullSync: boolean): Promise<void> {
		// Dwie równoległe synchronizacje pisałyby do tych samych plików.
		if (this.isSyncing) {
			new Notice('Synchronizacja już trwa.');
			return;
		}
		this.isSyncing = true;

		// Notice z czasem 0 nie znika sam — użyjemy go jako paska postępu
		// i schowamy ręcznie w bloku `finally`.
		const progress = new Notice('Strava: pobieranie aktywności…', 0);

		try {
			const accessToken = await this.ensureFreshToken();

			// W trybie przyrostowym przekazujemy Stravie `after`, czyli
			// "daj tylko aktywności rozpoczęte po tym momencie".
			const after = fullSync ? undefined : this.settings.lastSyncAfter;

			const activities: StravaActivity[] = [];
			let rateLimit: StravaRateLimit | null = null;
			let page = 1;
			// Czy przerwaliśmy pobieranie z powodu limitów? (ważne niżej)
			let stoppedEarly = false;

			// Strava dzieli wyniki na strony — kręcimy się, aż skończą się dane.
			for (;;) {
				const result = await fetchActivitiesPage(accessToken, page, after);
				activities.push(...result.activities);
				rateLimit = result.rateLimit;

				progress.setMessage(
					`Strava: pobrano ${activities.length} aktywności…`,
				);

				// Niepełna strona = to była ostatnia. Kończymy bez zbędnego
				// zapytania o pustą stronę numer N+1.
				if (result.activities.length < PER_PAGE) {
					break;
				}

				// Bezpiecznik limitów: zostawiamy sobie mały zapas zapytań.
				if (
					rateLimit &&
					rateLimit.shortTermLimit - rateLimit.shortTermUsage <=
						RATE_LIMIT_RESERVE
				) {
					stoppedEarly = true;
					new Notice(
						'Zbliżasz się do limitu zapytań Stravy — przerywam pobieranie. ' +
							'Zapisuję to, co udało się pobrać, i dokończ za kilkanaście minut.',
					);
					break;
				}

				page++;
				await sleep(PAGE_DELAY_MS);
			}

			// Nic nowego — kończymy bez tworzenia folderu i bez zapisu.
			if (activities.length === 0) {
				new Notice('Strava: brak nowych aktywności.');
				return;
			}

			// Odsiewamy treningi siłowe (patrz filter.ts) — dla nich notatek
			// nie tworzymy, bo mamy je już z pluginu hevy-sync.
			const toWrite = activities.filter(
				(activity) => !isSkippedActivity(activity),
			);
			const skipped = activities.length - toWrite.length;

			let created = 0;
			let updated = 0;

			// Gdy po odsianiu nic nie zostało, nie zakładamy nawet folderu.
			if (toWrite.length > 0) {
				const folderPath = normalizePath(this.settings.activitiesFolder);
				await this.ensureFolder(folderPath);

				for (const activity of toWrite) {
					const markdown = formatActivity(activity);
					// ID aktywności jest liczbą i nigdy nie zawiera znaków
					// zakazanych w nazwach plików — nie trzeba go czyścić.
					const path = normalizePath(`${folderPath}/${activity.id}.md`);

					const existing = this.app.vault.getAbstractFileByPath(path);
					if (existing instanceof TFile) {
						await this.app.vault.modify(existing, markdown);
						updated++;
					} else {
						await this.app.vault.create(path, markdown);
						created++;
					}
				}
			}

			// Zapamiętujemy datę najnowszej aktywności — od niej ruszy kolejny sync.
			//
			// UWAGA: liczymy z `activities`, czyli ze WSZYSTKICH pobranych, także
			// z pominiętych treningów siłowych. Gdybyśmy liczyli tylko z zapisanych,
			// najnowszy trening siłowy blokowałby znacznik i przy każdym syncu
			// pobieralibyśmy go od nowa — bez sensu przy limitach Stravy.
			//
			// Robimy to TYLKO wtedy, gdy przeszliśmy wszystkie strony. Gdybyśmy
			// przerwali na limicie, przesunięcie znacznika mogłoby trwale
			// przeskoczyć aktywności, których jeszcze nie pobraliśmy.
			if (!stoppedEarly) {
				const newest = activities.reduce(
					(max, activity) =>
						Math.max(max, Math.floor(Date.parse(activity.start_date) / 1000)),
					this.settings.lastSyncAfter,
				);
				this.settings.lastSyncAfter = newest;
				await this.saveSettings();
			}

			// Podsumowanie + informacja o zużyciu limitu prosto z nagłówków Stravy.
			const limitInfo = rateLimit
				? ` (limit 15 min: ${rateLimit.shortTermUsage}/${rateLimit.shortTermLimit}, dzienny: ${rateLimit.dailyUsage}/${rateLimit.dailyLimit})`
				: '';
			// O pominiętych mówimy wprost, żeby nie wyglądało, że coś zginęło.
			const skippedInfo =
				skipped > 0 ? `, pominięte siłowe ${skipped}` : '';
			new Notice(
				`Strava: nowe notatki ${created}, zaktualizowane ${updated}${skippedInfo}${limitInfo}`,
			);
		} catch (error: unknown) {
			// Trzy typowe scenariusze rozróżniamy, żeby dać konkretną radę.
			if (error instanceof StravaRateLimitError) {
				new Notice(error.message);
			} else if (error instanceof StravaAuthError) {
				new Notice(error.message);
			} else {
				new Notice(
					`Błąd podczas synchronizacji ze Stravą: ${(error as Error).message}`,
				);
			}
			console.error(error);
		} finally {
			// `finally` wykonuje się zawsze — także po błędzie i po `return`
			// ze środka `try`. Idealne miejsce na sprzątanie.
			progress.hide();
			this.isSyncing = false;
		}
	}

	/** Tworzy folder na notatki, jeśli jeszcze nie istnieje. */
	private async ensureFolder(folderPath: string): Promise<void> {
		if (this.app.vault.getAbstractFileByPath(folderPath)) {
			return;
		}
		try {
			await this.app.vault.createFolder(folderPath);
		} catch (error: unknown) {
			// Folder mógł powstać w międzyczasie (np. przez synchronizację
			// skarbca) — to nie jest powód, żeby przerywać synchronizację.
			console.error(error);
		}
	}

	// ------------------------------------------------------------------
	// USTAWIENIA
	// ------------------------------------------------------------------

	/**
	 * Wczytuje ustawienia z data.json.
	 * Object.assign nakłada zapisane wartości na domyślne, więc po dodaniu
	 * nowego ustawienia stare pliki data.json nadal działają.
	 */
	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<StravaSyncSettings>,
		);
	}

	/** Zapisuje ustawienia do data.json. */
	async saveSettings() {
		await this.saveData(this.settings);
	}
}
