// ============================================================================
// stravaApi.ts — cała komunikacja z serwerami Stravy.
//
// Używamy `requestUrl` z Obsidiana zamiast przeglądarkowego `fetch`, bo
// requestUrl omija blokadę CORS (Obsidian wysyła zapytanie "z zewnątrz"
// przeglądarki). To zalecany sposób w pluginach Obsidiana.
// ============================================================================

import { requestUrl } from 'obsidian';
import type {
	ActivitiesPage,
	StravaActivity,
	StravaRateLimit,
	StravaTokenResponse,
} from './types';

/** Adres endpointu wymiany/odświeżania tokenów. */
const TOKEN_URL = 'https://www.strava.com/oauth/token';
/** Adres API v3. */
const API_URL = 'https://www.strava.com/api/v3';

/**
 * Maksymalna liczba aktywności na jednej stronie.
 * Strava pozwala na 200 i to jest KLUCZOWA optymalizacja: 1000 aktywności to
 * 5 zapytań zamiast 50 przy domyślnym per_page=30.
 */
export const PER_PAGE = 200;

/**
 * Błąd rzucany, gdy Strava odpowie 429 (przekroczony limit zapytań).
 * Własna klasa błędu pozwala nam w main.ts rozpoznać ten przypadek
 * i pokazać użytkownikowi sensowny komunikat zamiast surowego wyjątku.
 */
export class StravaRateLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StravaRateLimitError';
	}
}

/**
 * Błąd rzucany, gdy Strava odpowie 401 (token nieważny / cofnięta zgoda).
 * Sygnał dla użytkownika: trzeba połączyć konto od nowa.
 */
export class StravaAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StravaAuthError';
	}
}

/**
 * Odczytuje nagłówek niezależnie od wielkości liter.
 * Serwery i Electron potrafią zwracać "X-RateLimit-Usage" albo
 * "x-ratelimit-usage", więc porównujemy wszystko małymi literami.
 */
function getHeader(
	headers: Record<string, string>,
	name: string,
): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) {
			return value;
		}
	}
	return undefined;
}

/**
 * Wyciąga stan limitów z nagłówków odpowiedzi.
 *
 * Strava wysyła je w formacie "krótkoterminowy,dzienny", np.:
 *   X-RateLimit-Limit: 200,2000
 *   X-RateLimit-Usage: 34,120
 * czyli: zużyliśmy 34 z 200 zapytań w tym 15-minutowym okienku
 * oraz 120 z 2000 zapytań dzisiaj.
 *
 * Zwraca `null`, gdy nagłówków nie ma (np. przy błędzie sieci) — wtedy po
 * prostu nie pokazujemy informacji o limitach.
 */
export function parseRateLimit(
	headers: Record<string, string>,
): StravaRateLimit | null {
	// Nowsze aplikacje dostają osobne limity na odczyt (ReadRateLimit).
	// Jeśli są dostępne — są dokładniejsze, więc mają pierwszeństwo.
	const limitHeader =
		getHeader(headers, 'x-readratelimit-limit') ??
		getHeader(headers, 'x-ratelimit-limit');
	const usageHeader =
		getHeader(headers, 'x-readratelimit-usage') ??
		getHeader(headers, 'x-ratelimit-usage');

	if (!limitHeader || !usageHeader) {
		return null;
	}

	// "200,2000" -> [200, 2000]
	const limits = limitHeader.split(',').map((part) => Number(part.trim()));
	const usages = usageHeader.split(',').map((part) => Number(part.trim()));

	// Gdyby format się zmienił, lepiej zwrócić null niż NaN-y.
	if (limits.length < 2 || usages.length < 2) {
		return null;
	}

	return {
		shortTermUsage: usages[0] ?? 0,
		shortTermLimit: limits[0] ?? 0,
		dailyUsage: usages[1] ?? 0,
		dailyLimit: limits[1] ?? 0,
	};
}

/**
 * Wysyła zapytanie POST do endpointu tokenów.
 * Strava oczekuje danych w formacie formularza (x-www-form-urlencoded),
 * a nie JSON-a — dlatego budujemy body przez URLSearchParams.
 */
async function postToken(
	params: Record<string, string>,
): Promise<StravaTokenResponse> {
	const response = await requestUrl({
		url: TOKEN_URL,
		method: 'POST',
		contentType: 'application/x-www-form-urlencoded',
		body: new URLSearchParams(params).toString(),
		// `throw: false` = nie rzucaj wyjątku przy błędzie HTTP.
		// Chcemy sami obejrzeć status i pokazać czytelny komunikat.
		throw: false,
	});

	if (response.status !== 200) {
		throw new Error(
			`Strava odrzuciła żądanie tokenu (HTTP ${response.status}). ` +
				`Sprawdź Client ID i Client Secret. Odpowiedź: ${response.text}`,
		);
	}

	return response.json as StravaTokenResponse;
}

/**
 * KROK 2 OAuth: zamiana jednorazowego kodu autoryzacji na parę tokenów.
 * Kod dostajemy z przeglądarki po tym, jak użytkownik kliknie "Authorize".
 */
export async function exchangeCodeForToken(
	clientId: string,
	clientSecret: string,
	code: string,
): Promise<StravaTokenResponse> {
	return postToken({
		client_id: clientId,
		client_secret: clientSecret,
		code,
		grant_type: 'authorization_code',
	});
}

/**
 * Odświeżenie wygasłego access_token przy pomocy refresh_token.
 * Uwaga: Strava może przy okazji zwrócić NOWY refresh_token — trzeba go
 * zapisać, inaczej przy kolejnym odświeżeniu użyjemy nieważnego.
 */
export async function refreshAccessToken(
	clientId: string,
	clientSecret: string,
	refreshToken: string,
): Promise<StravaTokenResponse> {
	return postToken({
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: refreshToken,
		grant_type: 'refresh_token',
	});
}

/**
 * Pobiera JEDNĄ stronę aktywności zalogowanego sportowca.
 *
 * @param accessToken ważny token dostępu
 * @param page numer strony, liczony od 1
 * @param after opcjonalny znacznik czasu (sekundy uniksowe) — Strava zwróci
 *              tylko aktywności rozpoczęte PÓŹNIEJ niż ten moment.
 *              To druga kluczowa optymalizacja: przy kolejnych synchronizacjach
 *              pobieramy wyłącznie nowe treningi, a nie całą historię.
 */
export async function fetchActivitiesPage(
	accessToken: string,
	page: number,
	after?: number,
): Promise<ActivitiesPage> {
	// Budujemy parametry adresu w bezpieczny sposób (kodowanie znaków itd.).
	const query = new URLSearchParams({
		page: String(page),
		per_page: String(PER_PAGE),
	});
	if (after && after > 0) {
		query.set('after', String(after));
	}

	const response = await requestUrl({
		url: `${API_URL}/athlete/activities?${query.toString()}`,
		method: 'GET',
		headers: { Authorization: `Bearer ${accessToken}` },
		throw: false,
	});

	// Limity znamy nawet przy błędzie, więc czytamy je zawsze.
	const rateLimit = parseRateLimit(response.headers);

	// 429 = wyczerpany limit zapytań. Nie ma sensu próbować dalej.
	if (response.status === 429) {
		throw new StravaRateLimitError(
			'Przekroczono limit zapytań do Stravy. Okienko 15-minutowe resetuje ' +
				'się o pełnych 00, 15, 30 i 45 minutach — spróbuj ponownie później.',
		);
	}

	// 401 = token nieważny albo użytkownik cofnął dostęp w ustawieniach Stravy.
	if (response.status === 401) {
		throw new StravaAuthError(
			'Strava odrzuciła token dostępu. Połącz konto ponownie w ustawieniach pluginu.',
		);
	}

	if (response.status !== 200) {
		throw new Error(
			`Strava zwróciła błąd HTTP ${response.status}: ${response.text}`,
		);
	}

	return {
		activities: response.json as StravaActivity[],
		rateLimit,
	};
}
