// ============================================================================
// filter.ts — decyduje, dla których aktywności NIE tworzymy notatek.
//
// Po co to? Treningi siłowe trafiają do Obsidiana z innego źródła
// (plugin hevy-sync), więc notatka ze Stravy byłaby duplikatem.
// ============================================================================

import type { StravaActivity } from './types';

/**
 * Typy sportu pomijane przy tworzeniu notatek.
 *
 * `WeightTraining` to dokładnie to, co Strava pokazuje po polsku jako
 * "Trening siłowy" — i tak właśnie oznaczane są treningi wyeksportowane
 * z Hevy.
 *
 * CHCESZ POMIJAĆ WIĘCEJ? Dopisz nazwę do tej listy. Przydatne nazwy ze Stravy:
 *   'Crossfit'                       — Crossfit
 *   'Workout'                        — ogólne "Trening"
 *   'HighIntensityIntervalTraining'  — HIIT
 *   'Yoga', 'Pilates'
 */
const SKIPPED_SPORT_TYPES = new Set<string>(['WeightTraining']);

/**
 * Czy dla tej aktywności pominąć tworzenie notatki?
 *
 * Sprawdzamy oba pola, bo Strava ma dwa: nowsze `sport_type` (dokładniejsze)
 * i starsze `type`. Przy starych aktywnościach jedno z nich bywa puste,
 * więc wystarczy, że którekolwiek pasuje.
 */
export function isSkippedActivity(activity: StravaActivity): boolean {
	return (
		SKIPPED_SPORT_TYPES.has(activity.sport_type) ||
		SKIPPED_SPORT_TYPES.has(activity.type)
	);
}
