// ============================================================================
// format.ts — zamiana danych z API na tekst notatki (Markdown).
//
// Ten plik nic nie zapisuje i nic nie pobiera — dostaje obiekt aktywności
// i zwraca gotowy tekst. Dzięki temu łatwo go czytać i zmieniać wygląd
// notatek bez ruszania reszty pluginu.
// ============================================================================

import type { StravaActivity } from './types';

/** Sporty "na nogach" — dla nich zamiast prędkości pokazujemy tempo (min/km). */
const FOOT_SPORTS = new Set([
	'Run',
	'TrailRun',
	'VirtualRun',
	'Walk',
	'Hike',
]);

/**
 * Sekundy -> czytelny czas.
 * 2712 -> "45:12", a 3725 -> "1:02:05".
 * padStart(2, '0') dokleja zero z przodu, żeby było "05", a nie "5".
 */
export function formatDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = Math.floor(totalSeconds % 60);

	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
	}
	return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Tempo biegowe: ile minut i sekund zajmuje jeden kilometr.
 * Zwraca null, gdy dystans jest zerowy (np. trening siłowy) — wtedy
 * dzielenie nie ma sensu i po prostu pomijamy tę linijkę w notatce.
 */
export function formatPace(
	distanceMeters: number,
	movingSeconds: number,
): string | null {
	if (distanceMeters <= 0 || movingSeconds <= 0) {
		return null;
	}
	const secondsPerKm = movingSeconds / (distanceMeters / 1000);
	const minutes = Math.floor(secondsPerKm / 60);
	const seconds = Math.round(secondsPerKm % 60);

	// Zaokrąglenie mogło dać 60 sekund — przenosimy je na minuty.
	if (seconds === 60) {
		return `${minutes + 1}:00 /km`;
	}
	return `${minutes}:${String(seconds).padStart(2, '0')} /km`;
}

/**
 * Zabezpiecza wartość przed zepsuciem bloku YAML we frontmatterze.
 *
 * Problem: tytuł aktywności typu "Bieg: 10 km #PB" zawiera znaki, które YAML
 * traktuje specjalnie i notatka miałaby uszkodzone właściwości.
 * Rozwiązanie: jeśli tekst zawiera taki znak, opakowujemy go w cudzysłowy
 * (a same cudzysłowy w środku podwajamy, tak każe standard YAML).
 */
function toYamlValue(value: string): string {
	const needsQuotes =
		value === '' ||
		/[:#\-?,[\]{}&*!|>'"%@`]/.test(value) ||
		value !== value.trim();

	if (!needsQuotes) {
		return value;
	}
	return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Buduje blok właściwości (frontmatter) na początku notatki.
 * Format jest taki sam jak w pluginie hevy-sync: dwie właściwości `date`
 * i `title` między liniami "---".
 *
 * Wynik wygląda tak:
 *   ---
 *   date: 2025-08-12
 *   title: Morning Run
 *   ---
 *
 * `date` bierzemy ze `start_date_local`, czyli z lokalnej strefy sportowca —
 * inaczej trening o 1:00 w nocy trafiłby na zły dzień.
 * split('T')[0] ucina godzinę z "2025-08-12T06:31:00Z" i zostawia samą datę.
 */
export function formatFrontmatter(activity: StravaActivity): string {
	const frontmatter = {
		date: activity.start_date_local.split('T')[0] ?? '',
		title: toYamlValue(activity.name),
	};

	return `---\n${Object.entries(frontmatter)
		.map(([key, value]) => `${key}: ${value}`)
		.join('\n')}\n---\n\n`;
}

/**
 * Główna funkcja: cała aktywność -> gotowa treść pliku .md.
 *
 * Uwaga: korzystamy wyłącznie z danych "summary" (te z listy aktywności).
 * Opis treningu i kalorie są dostępne tylko w wersji szczegółowej, która
 * kosztuje jedno dodatkowe zapytanie NA KAŻDĄ aktywność — przy limicie
 * Stravy to bardzo droga zabawa, więc świadomie z nich rezygnujemy.
 */
export function formatActivity(activity: StravaActivity): string {
	const frontmatter = formatFrontmatter(activity);

	// Nagłówek notatki: tytuł i data startu (tak jak w hevy-sync).
	//
	// Dziwactwo Stravy: `start_date_local` to godzina lokalna, ale kończy się
	// literą "Z", która w standardzie ISO oznacza czas UTC. Ucinamy ją, żeby
	// notatka nie sugerowała złej strefy czasowej.
	const localStart = activity.start_date_local.replace(/Z$/, '');
	const header = `# ${activity.name}\n\n${localStart}`;

	// Listę statystyk budujemy krok po kroku, bo część pól bywa pusta.
	const stats: string[] = [];

	// sport_type jest dokładniejszy (np. "GravelRide"), ale starsze aktywności
	// mogą go nie mieć — wtedy używamy zwykłego `type`.
	stats.push(`- Sport: ${activity.sport_type || activity.type}`);

	// Metry -> kilometry z dokładnością do 2 miejsc po przecinku.
	if (activity.distance > 0) {
		stats.push(`- Distance: ${(activity.distance / 1000).toFixed(2)} km`);
	}

	stats.push(`- Moving time: ${formatDuration(activity.moving_time)}`);

	// Czas całkowity pokazujemy tylko, gdy różni się od czasu w ruchu —
	// przy identycznych wartościach byłaby to zbędna linijka.
	if (activity.elapsed_time !== activity.moving_time) {
		stats.push(`- Elapsed time: ${formatDuration(activity.elapsed_time)}`);
	}

	if (activity.total_elevation_gain > 0) {
		stats.push(`- Elevation gain: ${Math.round(activity.total_elevation_gain)} m`);
	}

	// Bieganie/chodzenie mierzymy tempem, resztę prędkością.
	const sport = activity.sport_type || activity.type;
	if (FOOT_SPORTS.has(sport)) {
		const pace = formatPace(activity.distance, activity.moving_time);
		if (pace) {
			stats.push(`- Average pace: ${pace}`);
		}
	} else if (activity.average_speed > 0) {
		// m/s -> km/h, czyli razy 3.6
		stats.push(
			`- Average speed: ${(activity.average_speed * 3.6).toFixed(1)} km/h`,
		);
	}

	// Tętno tylko wtedy, gdy trening był nagrywany z pulsometrem.
	if (activity.average_heartrate) {
		stats.push(`- Average heart rate: ${Math.round(activity.average_heartrate)} bpm`);
	}
	if (activity.max_heartrate) {
		stats.push(`- Max heart rate: ${Math.round(activity.max_heartrate)} bpm`);
	}

	// Moc — praktycznie tylko rowery z miernikiem mocy.
	if (activity.average_watts) {
		stats.push(`- Average power: ${Math.round(activity.average_watts)} W`);
	}

	// Odnośnik do oryginalnej aktywności na Stravie.
	const link = `[View on Strava](https://www.strava.com/activities/${activity.id})`;

	return `${frontmatter}${header}\n\n## Stats\n${stats.join('\n')}\n\n${link}\n`;
}
