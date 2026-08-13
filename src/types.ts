// ============================================================================
// types.ts — wszystkie "kształty" danych, których używamy w pluginie.
//
// TypeScript nie sprawdza w locie, co naprawdę przyjdzie z internetu — te
// interfejsy to tylko obietnica, jak wyglądają dane ze Stravy. Dzięki nim
// edytor podpowiada nazwy pól i krzyczy, gdy zrobimy literówkę.
// ============================================================================

/**
 * Odpowiedź endpointu https://www.strava.com/oauth/token
 * Dostajemy ją w dwóch sytuacjach:
 *  1. po wymianie kodu autoryzacji na tokeny (pierwsze logowanie),
 *  2. po odświeżeniu wygasłego tokenu (refresh).
 */
export interface StravaTokenResponse {
	/** Krótkoterminowy token do zapytań o dane. Ważny ~6 godzin. */
	access_token: string;
	/** Długoterminowy token służący TYLKO do wyrabiania nowych access_token. */
	refresh_token: string;
	/** Moment wygaśnięcia access_token — sekundy uniksowe (nie milisekundy!). */
	expires_at: number;
	/** Ile sekund zostało do wygaśnięcia w chwili odpowiedzi. */
	expires_in: number;
	/** Typ tokenu, zawsze "Bearer". */
	token_type: string;
	/** Dane sportowca — Strava dołącza je tylko przy pierwszym logowaniu. */
	athlete?: {
		id: number;
		firstname: string;
		lastname: string;
	};
}

/**
 * Pojedyncza aktywność w wersji "summary" — to, co zwraca lista
 * /athlete/activities. Wersja "detailed" (pojedyncza aktywność) ma więcej pól
 * (np. opis i kalorie), ale kosztuje jedno zapytanie NA AKTYWNOŚĆ, więc
 * świadomie z niej nie korzystamy — patrz limity Stravy w README/INSTRUKCJA.
 *
 * Pola oznaczone `?` bywają nieobecne (np. tętno, gdy nie było pulsometru).
 */
export interface StravaActivity {
	/** Unikalne ID aktywności — używamy go jako nazwy pliku notatki. */
	id: number;
	/** Nazwa aktywności, np. "Morning Run". */
	name: string;
	/** Dystans w metrach. */
	distance: number;
	/** Czas w ruchu (bez postojów) w sekundach. */
	moving_time: number;
	/** Czas całkowity (z postojami) w sekundach. */
	elapsed_time: number;
	/** Suma podbiegów/podjazdów w metrach. */
	total_elevation_gain: number;
	/** Starszy typ aktywności, np. "Run", "Ride". */
	type: string;
	/** Nowszy, dokładniejszy typ, np. "TrailRun", "GravelRide". */
	sport_type: string;
	/** Data startu w UTC, format ISO: "2025-08-12T06:31:00Z". */
	start_date: string;
	/** Data startu w strefie czasowej sportowca — tej używamy w notatce. */
	start_date_local: string;
	/** Średnia prędkość w metrach na sekundę. */
	average_speed: number;
	/** Maksymalna prędkość w metrach na sekundę. */
	max_speed: number;
	/** Czy aktywność ma zapisane tętno. */
	has_heartrate?: boolean;
	average_heartrate?: number;
	max_heartrate?: number;
	/** Średnia moc w watach (rower z miernikiem mocy). */
	average_watts?: number;
	/** Praca w kilodżulach (rower). */
	kilojoules?: number;
	/** Czy trening był ręcznie dodany (bez pliku GPS). */
	manual?: boolean;
	/** Czy aktywność jest prywatna. */
	private?: boolean;
}

/**
 * Stan limitów zapytań odczytany z nagłówków odpowiedzi Stravy.
 * Strava przysyła je przy KAŻDEJ odpowiedzi, więc znamy zużycie na bieżąco.
 */
export interface StravaRateLimit {
	/** Ile zapytań zużyliśmy w bieżącym 15-minutowym okienku. */
	shortTermUsage: number;
	/** Limit zapytań na 15 minut (domyślnie 100 lub 200 zależnie od aplikacji). */
	shortTermLimit: number;
	/** Ile zapytań zużyliśmy dzisiaj. */
	dailyUsage: number;
	/** Limit dzienny (domyślnie 1000 lub 2000). */
	dailyLimit: number;
}

/** Wynik pobrania jednej strony aktywności: dane + aktualny stan limitów. */
export interface ActivitiesPage {
	activities: StravaActivity[];
	rateLimit: StravaRateLimit | null;
}
