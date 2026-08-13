// ============================================================================
// oauth.ts — logowanie do Stravy (OAuth 2.0).
//
// JAK TO DZIAŁA W SKRÓCIE (tzw. "loopback flow"):
//  1. Plugin uruchamia malutki serwer HTTP na Twoim komputerze
//     (np. http://localhost:42813) — działa tylko przez chwilę logowania.
//  2. Otwieramy w przeglądarce stronę Stravy z prośbą o zgodę.
//  3. Po kliknięciu "Authorize" Strava przekierowuje przeglądarkę na nasz
//     lokalny adres i doklei do niego jednorazowy `code`.
//  4. Serwer odbiera ten `code`, pokazuje stronę "możesz zamknąć kartę"
//     i natychmiast się wyłącza.
//  5. Kod wymieniamy na access_token + refresh_token (stravaApi.ts).
//
// DLACZEGO SERWER LOKALNY, A NIE `obsidian://`?
// Strava w ustawieniach aplikacji wymaga "Authorization Callback Domain" —
// czyli prawdziwej domeny. Nie akceptuje własnych protokołów typu obsidian://.
// `localhost` jest domeną i jest akceptowany. Konsekwencja: plugin działa
// tylko na komputerze (manifest ma "isDesktopOnly": true), bo na telefonie
// nie da się uruchomić serwera HTTP.
// ============================================================================

// Moduł 'http' pochodzi z Node.js. Obsidian na komputerze działa na Electronie,
// więc moduły Node są dostępne. esbuild zostawia je jako "external"
// (patrz esbuild.config.mjs), czyli nie próbuje ich wpakować do main.js.
import { createServer, type Server } from 'http';
import { exchangeCodeForToken } from './stravaApi';
import type { StravaTokenResponse } from './types';

/**
 * Uprawnienia, o które prosimy Stravę.
 * - activity:read_all — pozwala czytać także aktywności prywatnych/ukrytych.
 *   Gdyby wystarczyły publiczne, można zmienić na 'activity:read'.
 * Prosimy o możliwie mało: NIE prosimy o prawo zapisu ani o dane e-mail.
 */
const SCOPE = 'activity:read_all';

/** Ile sekund czekamy na kliknięcie "Authorize", zanim się poddamy. */
const TIMEOUT_SECONDS = 180;

/**
 * Strona HTML pokazywana w przeglądarce po powrocie ze Stravy.
 * Jest celowo minimalna — to tylko informacja dla użytkownika.
 */
function resultPage(title: string, message: string): string {
	return `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem">
<h1>${title}</h1><p>${message}</p></body></html>`;
}

/**
 * Uchwyt do aktualnie działającego serwera logowania.
 * Trzymamy go poza funkcją, żeby plugin mógł go zamknąć przy wyłączaniu
 * (`onunload`) — inaczej port zostałby zajęty do końca limitu czasu.
 */
let activeServer: Server | null = null;

/**
 * Awaryjne zamknięcie serwera logowania.
 * Wywołujemy je przy wyłączaniu pluginu.
 */
export function cancelAuthorization(): void {
	if (activeServer) {
		activeServer.close();
		activeServer = null;
	}
}

/**
 * Losowy ciąg znaków używany jako parametr `state`.
 *
 * `state` chroni przed atakiem CSRF: Strava odsyła nam dokładnie tę samą
 * wartość, więc jeśli ktoś podrzuci nam obcy kod autoryzacji na nasz lokalny
 * adres, `state` się nie zgodzi i odrzucimy żądanie.
 */
function randomState(): string {
	// crypto.randomUUID jest dostępne w środowisku Obsidiana.
	return crypto.randomUUID();
}

/**
 * Przeprowadza całe logowanie i zwraca gotowe tokeny.
 *
 * Zwrócony obiekt zawiera access_token, refresh_token i expires_at —
 * to główny wynik, który plugin zapisuje w swoich ustawieniach.
 *
 * @param clientId     Client ID z https://www.strava.com/settings/api
 * @param clientSecret Client Secret z tej samej strony
 * @param port         port lokalnego serwera (musi być wolny)
 * @param onServerReady wywoływane, gdy serwer wstał — tu otwieramy przeglądarkę
 */
export function authorizeWithStrava(
	clientId: string,
	clientSecret: string,
	port: number,
	onServerReady: (authorizeUrl: string) => void,
): Promise<StravaTokenResponse> {
	// Promise = "obietnica wyniku w przyszłości". Rozwiążemy ją (`resolve`),
	// gdy dostaniemy tokeny, albo odrzucimy (`reject`) przy błędzie.
	return new Promise<StravaTokenResponse>((resolve, reject) => {
		const state = randomState();
		const redirectUri = `http://localhost:${port}/callback`;

		// Zmienne pomocnicze, żeby posprzątać dokładnie raz.
		let server: Server | null = null;
		let timeoutId: number | null = null;

		/** Zamyka serwer i kasuje licznik czasu. Bezpieczne do wielokrotnego wywołania. */
		const cleanup = () => {
			if (timeoutId !== null) {
				window.clearTimeout(timeoutId);
				timeoutId = null;
			}
			if (server) {
				// Zerujemy globalny uchwyt tylko wtedy, gdy wskazuje na NASZ serwer
				// (przy dwóch próbach logowania mógłby już wskazywać na nowszy).
				if (activeServer === server) {
					activeServer = null;
				}
				server.close();
				server = null;
			}
		};

		// Gdyby ktoś kliknął "Connect" dwa razy — zwalniamy poprzedni serwer,
		// żeby nie walczyć o ten sam port.
		cancelAuthorization();

		// --- Serwer odbierający przekierowanie ze Stravy --------------------
		server = createServer((req, res) => {
			// req.url to sama ścieżka ("/callback?code=..."), więc doklejamy
			// bazę, żeby móc użyć wygodnego parsera URL.
			const url = new URL(req.url ?? '/', `http://localhost:${port}`);

			/**
			 * Odsyła stronę do przeglądarki.
			 * Nagłówek "Connection: close" jest tu ważny: bez niego przeglądarka
			 * trzymałaby połączenie otwarte, a wtedy `server.close()` czekałoby
			 * z oddaniem portu — kolejne logowanie mogłoby się nie udać.
			 */
			const send = (status: number, title: string, message: string) => {
				res.writeHead(status, {
					'Content-Type': 'text/html; charset=utf-8',
					Connection: 'close',
				});
				res.end(resultPage(title, message));
			};

			// Przeglądarki lubią prosić dodatkowo o /favicon.ico — ignorujemy.
			if (url.pathname !== '/callback') {
				res.writeHead(404, { Connection: 'close' });
				res.end();
				return;
			}

			const code = url.searchParams.get('code');
			const error = url.searchParams.get('error');
			const returnedState = url.searchParams.get('state');

			// Użytkownik kliknął "Cancel" na stronie Stravy.
			if (error) {
				send(200, 'Nie udało się', `Strava zwróciła błąd: ${error}`);
				cleanup();
				reject(new Error(`Autoryzacja odrzucona: ${error}`));
				return;
			}

			// Zabezpieczenie CSRF opisane wyżej.
			if (returnedState !== state) {
				send(400, 'Nie udało się', 'Niezgodny parametr state.');
				cleanup();
				reject(new Error('Niezgodny parametr state — logowanie przerwane.'));
				return;
			}

			if (!code) {
				send(400, 'Nie udało się', 'Brak kodu autoryzacji.');
				cleanup();
				reject(new Error('Strava nie przysłała kodu autoryzacji.'));
				return;
			}

			// Sukces — pokazujemy stronę i od razu zwalniamy port.
			send(
				200,
				'Połączono ze Stravą',
				'Możesz zamknąć tę kartę i wrócić do Obsidiana.',
			);
			cleanup();

			// Ostatni krok: kod -> tokeny.
			exchangeCodeForToken(clientId, clientSecret, code).then(resolve, reject);
		});

		// Najczęstszy błąd: port zajęty (EADDRINUSE) przez inny program.
		server.on('error', (err: NodeJS.ErrnoException) => {
			cleanup();
			if (err.code === 'EADDRINUSE') {
				reject(
					new Error(
						`Port ${port} jest zajęty. Zmień "Callback port" w ustawieniach ` +
							'pluginu i pamiętaj, żeby zmienić też redirect URI po stronie Stravy.',
					),
				);
			} else {
				reject(err);
			}
		});

		// Zapamiętujemy serwer, żeby dało się go zamknąć z zewnątrz.
		activeServer = server;

		// Nasłuchujemy tylko na pętli lokalnej (127.0.0.1), więc serwer nie jest
		// widoczny dla innych urządzeń w sieci.
		server.listen(port, '127.0.0.1', () => {
			// Adres strony zgody. approval_prompt=auto = nie pytaj drugi raz,
			// jeśli użytkownik już wcześniej wyraził zgodę.
			const authorizeUrl =
				'https://www.strava.com/oauth/authorize?' +
				new URLSearchParams({
					client_id: clientId,
					redirect_uri: redirectUri,
					response_type: 'code',
					approval_prompt: 'auto',
					scope: SCOPE,
					state,
				}).toString();

			onServerReady(authorizeUrl);
		});

		// Gdyby użytkownik zostawił otwartą kartę i poszedł na kawę —
		// nie trzymamy portu w nieskończoność.
		timeoutId = window.setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`Minęło ${TIMEOUT_SECONDS} s bez odpowiedzi ze Stravy. Spróbuj ponownie.`,
				),
			);
		}, TIMEOUT_SECONDS * 1000);
	});
}
