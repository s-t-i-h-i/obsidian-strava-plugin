# Strava sync — instrukcja i opis zmian

Ten plik tłumaczy **wszystko od zera**: co plugin robi, jak go uruchomić i co
dokładnie znajduje się w każdym pliku z kodem. Pisany tak, żeby dało się go
czytać bez wcześniejszego doświadczenia z pluginami Obsidiana.

---

## 1. Co ten plugin robi

Trzy rzeczy, nic więcej:

1. **Logowanie do Stravy (OAuth)** — jednorazowe połączenie konta.
2. **Synchronizacja** — pobranie aktywności ze Stravy.
3. **Notatki** — dla każdej aktywności powstaje jeden plik `.md` w wybranym
   folderze, z właściwościami `date` i `title` (dokładnie w takim samym
   formacie jak w pluginie `hevy-sync`).

Obie akcje są dostępne w **dwóch miejscach**:

- w **Ustawienia → Strava sync** (przyciski),
- w **palecie komend** (`Cmd/Ctrl + P`):
  - `Strava sync: Connect to Strava`
  - `Strava sync: Sync activities`

---

## 2. Jak to uruchomić (krok po kroku)

### Krok A — zbuduj plugin

W folderze pluginu w terminalu:

```bash
npm install && npm run build
```

Powstanie plik `main.js` — to on jest ładowany przez Obsidiana. Podczas pracy
nad kodem wygodniejsze jest `npm run dev` (przebudowuje się automatycznie po
każdej zmianie).

### Krok B — załóż aplikację w Stravie

Strava nie wpuszcza programów „z ulicy" — każdy potrzebuje własnego zestawu
kluczy. Wejdź na <https://www.strava.com/settings/api> i utwórz aplikację:

| Pole | Co wpisać |
| --- | --- |
| Application Name | cokolwiek, np. `Obsidian` |
| Category | np. `Data Importer` |
| Website | cokolwiek, np. `https://obsidian.md` |
| **Authorization Callback Domain** | **`localhost`** ← to jest kluczowe |

Po zapisaniu strona pokaże **Client ID** (liczba) i **Client Secret** (długi
ciąg znaków).

### Krok C — wpisz klucze w Obsidianie

**Ustawienia → Strava sync**:

1. Wklej `Client ID` i `Client secret`.
2. (Opcjonalnie) zmień `Activities folder` — domyślnie `Strava`.
3. Kliknij **Connect to Strava**. Otworzy się przeglądarka ze stroną zgody.
4. Kliknij **Authorize**. Przeglądarka pokaże „Połączono ze Stravą" — możesz
   zamknąć kartę.
5. Wróć do Obsidiana i kliknij **Sync now**.

### Krok D — gotowe

W folderze `Strava` pojawi się po jednym pliku na aktywność.

---

## 3. Jak wygląda notatka

Nazwa pliku to ID aktywności ze Stravy, np. `14567890123.md`
(tak samo jak w `hevy-sync`, gdzie plik nazywa się ID treningu).

```markdown
---
date: 2025-08-12
title: "Morning Run: 10k #PB"
---

# Morning Run: 10k #PB

2025-08-12T06:31:00

## Stats
- Sport: Run
- Distance: 10.05 km
- Moving time: 48:12
- Elapsed time: 50:01
- Elevation gain: 118 m
- Average pace: 4:48 /km
- Average heart rate: 152 bpm
- Max heart rate: 178 bpm

[View on Strava](https://www.strava.com/activities/14567890123)
```

Kilka decyzji, które warto znać:

- **`date` i `title`** to te same dwie właściwości i ten sam układ co w
  `hevy-sync` (blok między liniami `---`, klucz i wartość po dwukropku).
- **`date` bierzemy z czasu lokalnego** sportowca, nie z UTC. Inaczej trening
  o 1:00 w nocy trafiłby na poprzedni dzień.
- **Tytuł w cudzysłowie**, jeśli zawiera znaki specjalne YAML (`:`, `#`, itp.).
  Bez tego właściwości notatki by się zepsuły — patrz `Morning Run: 10k #PB`.
- **Tempo dla biegania/chodzenia, prędkość dla reszty** — dla roweru
  „4:48 /km" byłoby bez sensu.
- **Linie, które nie mają danych, po prostu nie powstają.** Nie ma pulsometru
  → nie ma linijki z tętnem.

---

## 4. Limity Stravy i jak plugin je oszczędza

To najważniejsza różnica względem `hevy-sync`. Strava liczy zapytania:

- **100 lub 200 zapytań na 15 minut** (okienko resetuje się o pełnych
  00, 15, 30 i 45 minutach),
- **1000 lub 2000 zapytań na dobę**.

(Która wartość — zależy od Twojej aplikacji. Plugin odczytuje ją z odpowiedzi
serwera, więc nie musisz nic wpisywać.)

Po przekroczeniu limitu Strava odpowiada błędem 429 i przez jakiś czas nie da
się nic pobrać. Dlatego plugin robi **sześć** rzeczy:

| # | Optymalizacja | Efekt |
| --- | --- | --- |
| 1 | `per_page=200` (maksimum, jakie Strava pozwala) | 1000 aktywności = **5 zapytań** zamiast 34 przy domyślnym `per_page=30` |
| 2 | Synchronizacja przyrostowa (`after=…`) | Codzienny sync to zwykle **1 zapytanie**, bo pytamy tylko o rzeczy nowsze od ostatnio zapisanej |
| 3 | Tylko lista aktywności, zero zapytań o pojedyncze treningi | Wersja szczegółowa (z opisem i kaloriami) kosztuje **1 zapytanie na aktywność** — przy 500 treningach to od razu poza limitem |
| 4 | Odświeżanie tokenu tylko gdy wygasa | Token żyje ~6 h; nie marnujemy zapytania przy każdym syncu |
| 5 | Odczyt nagłówków `X-RateLimit-*` i przerwanie przy zapasie 5 zapytań | Nie dostajesz błędu 429, tylko czytelny komunikat |
| 6 | Zatrzymanie na niepełnej stronie | Nie pytamy o pustą stronę „na wszelki wypadek" |

**Zwykły sync vs. Full sync:**

- `Sync now` — tryb przyrostowy, tani. Używaj na co dzień.
- `Full sync` — przechodzi całą historię i nadpisuje istniejące notatki.
  Przydaje się raz na jakiś czas (np. gdy zmieniłeś tytuły aktywności w
  Stravie albo dograłeś stary trening z inną datą).

Po każdej synchronizacji komunikat pokazuje aktualne zużycie limitu, np.
`(limit 15 min: 7/200, dzienny: 31/2000)`.

---

## 5. Co jest w którym pliku

Kod jest podzielony na małe pliki — każdy odpowiada za jedną rzecz. Cały jest
opisany komentarzami po polsku.

```
src/
  main.ts        ← cykl życia pluginu, komendy, przebieg synchronizacji
  settings.ts    ← co plugin zapamiętuje + wygląd zakładki ustawień
  oauth.ts       ← logowanie do Stravy
  stravaApi.ts   ← zapytania do API Stravy i obsługa limitów
  format.ts      ← zamiana danych na tekst notatki
  types.ts       ← opis kształtu danych ze Stravy
```

### `src/types.ts`

Same definicje typów — zero działającego kodu. Opisuje, jak wygląda
odpowiedź z tokenami, jak wygląda aktywność i jak wygląda stan limitów.
Dzięki temu edytor podpowiada nazwy pól i wyłapuje literówki.

### `src/stravaApi.ts`

Wszystkie rozmowy z serwerami Stravy:

- `exchangeCodeForToken()` — zamienia jednorazowy kod z przeglądarki na tokeny,
- `refreshAccessToken()` — odnawia wygasły token,
- `fetchActivitiesPage()` — pobiera jedną stronę aktywności (200 sztuk),
- `parseRateLimit()` — czyta z nagłówków, ile zapytań zostało.

Dwie własne klasy błędów, `StravaRateLimitError` i `StravaAuthError`,
pozwalają rozpoznać „skończył się limit" i „token przestał być ważny" i pokazać
konkretną radę zamiast surowego komunikatu.

Używamy `requestUrl` z Obsidiana, a nie zwykłego `fetch` — `requestUrl` omija
blokadę CORS, przez którą przeglądarkowe zapytania do obcych serwerów są
odrzucane.

### `src/oauth.ts`

Najciekawszy plik. OAuth wygląda tak:

1. Plugin uruchamia **malutki serwer HTTP na Twoim komputerze**
   (`http://localhost:42813`), który żyje tylko przez chwilę logowania.
2. Otwiera w przeglądarce stronę zgody Stravy.
3. Po kliknięciu „Authorize" Strava przekierowuje przeglądarkę z powrotem na
   ten lokalny adres, doklejając jednorazowy `code`.
4. Serwer odbiera kod, pokazuje „możesz zamknąć kartę" i natychmiast się gasi.
5. Kod jest wymieniany na tokeny.

**Dlaczego serwer, a nie `obsidian://`?** Strava w ustawieniach aplikacji
wymaga „Authorization Callback Domain", czyli prawdziwej domeny — nie akceptuje
własnych protokołów typu `obsidian://`. `localhost` jest domeną i przechodzi.
Konsekwencja: plugin działa **tylko na komputerze** (w `manifest.json` jest
`"isDesktopOnly": true`), bo na telefonie nie da się postawić serwera HTTP.

Zabezpieczenia w tym pliku:

- parametr **`state`** — losowy ciąg, który Strava odsyła nam z powrotem. Jeśli
  się nie zgadza, odrzucamy żądanie. Chroni przed podrzuceniem obcego kodu.
- serwer nasłuchuje tylko na **127.0.0.1**, więc nie jest widoczny w sieci,
- **limit czasu 3 minuty** — port nie zostaje zajęty w nieskończoność,
- `cancelAuthorization()` wywoływane przy wyłączeniu pluginu.

### `src/format.ts`

Dostaje obiekt aktywności, zwraca gotowy tekst notatki. Nic nie pobiera i nic
nie zapisuje, więc łatwo tu zmieniać wygląd notatek bez ruszania reszty.

Funkcje pomocnicze: `formatDuration()` (2712 s → `45:12`), `formatPace()`
(dystans + czas → `4:48 /km`), `toYamlValue()` (opakowuje tytuł w cudzysłowy,
gdy trzeba).

### `src/settings.ts`

Dwie rzeczy:

1. **`StravaSyncSettings`** — lista tego, co plugin pamięta. Część wpisujesz
   sam (Client ID, Client secret, folder, port), część plugin uzupełnia
   automatycznie (tokeny, data ostatniej synchronizacji).
2. **`StravaSettingTab`** — wygląd zakładki ustawień: status połączenia,
   przyciski Connect/Disconnect, pola tekstowe, przyciski Sync now i Full sync.

Wszystko trafia do pliku `data.json` w folderze pluginu. **Ten plik zawiera
Twoje tokeny — jest w `.gitignore` i nie wolno go nikomu wysyłać.**

### `src/main.ts`

Spina całość:

- `onload()` — rejestruje dwie komendy i zakładkę ustawień,
- `onunload()` — zamyka ewentualny serwer logowania,
- `connectToStrava()` — uruchamia logowanie i zapisuje tokeny,
- `disconnect()` — czyści tokeny,
- `ensureFreshToken()` — pilnuje, żeby token był ważny (odświeża z 5-minutowym
  zapasem),
- `syncActivities(fullSync)` — właściwa synchronizacja: pętla po stronach,
  bezpiecznik limitów, zapis notatek, aktualizacja znacznika czasu,
- `ensureFolder()` — tworzy folder na notatki, jeśli go nie ma.

Jeden szczegół wart uwagi: **znacznik ostatniej synchronizacji jest zapisywany
tylko wtedy, gdy pobraliśmy wszystkie strony.** Gdybyśmy przerwali na limicie i
mimo to przesunęli znacznik do przodu, aktywności z „dziury" nigdy by się nie
pobrały.

---

## 6. Lista zmian względem wyjściowego szablonu

Projekt startował z oficjalnego `obsidian-sample-plugin`. Co się zmieniło:

**Nowe pliki:**

- `src/types.ts`, `src/stravaApi.ts`, `src/oauth.ts`, `src/format.ts` — logika
  pluginu.
- `INSTRUKCJA.md` — ten plik.

**Przepisane od zera:**

- `src/main.ts` — usunięte wszystkie przykłady z szablonu (ikona na wstążce,
  pasek statusu, trzy demonstracyjne komendy, `SampleModal`, przykładowy
  `registerDomEvent` i `registerInterval`). Zostały dwie prawdziwe komendy.
- `src/settings.ts` — zamiast jednego przykładowego pola pełna zakładka.
- `README.md` — opis prawdziwego pluginu zamiast opisu szablonu.

**Zmiany w konfiguracji:**

- `manifest.json` — `id` zmienione na `obsidian-strava-plugin` (musi zgadzać
  się z nazwą folderu), nowa nazwa i opis, `isDesktopOnly` ustawione na `true`
  (bo używamy serwera HTTP z Node.js), `minAppVersion` podniesione do `1.4.0`
  (tej wersji wymaga `Vault.createFolder`).
- `versions.json` — mapowanie `1.0.0 → 1.4.0`, zgodnie z powyższym.
- `package.json` — nazwa i opis projektu.

Nietknięte zostały: `esbuild.config.mjs`, `tsconfig.json`, `eslint.config.mts`,
`.editorconfig`, workflowy GitHuba i `version-bump.mjs`.

**Sprawdzenie:** `npm run build` przechodzi bez błędów, `npm run lint` zgłasza
0 błędów. Zostaje 9 ostrzeżeń: 8 z reguły „sentence case", która nie wie, że
„Strava" to nazwa własna i chce „strava", oraz 1 sugestia przejścia na nowe,
deklaratywne API ustawień z Obsidiana 1.13. Żadne z nich niczego nie psuje.

---

## 7. Gdy coś nie działa

| Objaw | Przyczyna i rozwiązanie |
| --- | --- |
| `Port 42813 jest zajęty` | Inny program zajmuje port. Zmień `Callback port` w ustawieniach — domena w Stravie (`localhost`) zostaje bez zmian, więc nic więcej nie trzeba poprawiać. |
| Przeglądarka pokazuje błąd Stravy o `redirect_uri` | W ustawieniach aplikacji na Stravie w polu **Authorization Callback Domain** musi być dokładnie `localhost` — bez `http://`, bez portu, bez ukośnika. |
| `Strava odrzuciła żądanie tokenu (HTTP 400)` | Literówka w Client ID lub Client Secret. |
| `Strava odrzuciła token dostępu` | Cofnięta zgoda po stronie Stravy. Kliknij Disconnect, potem Connect jeszcze raz. |
| `Przekroczono limit zapytań` | Odczekaj do najbliższej pełnej kwadransa (00, 15, 30, 45) i spróbuj ponownie. |
| Brak nowych notatek mimo nowych treningów | Aktywność ma datę **starszą** niż ostatni sync (np. dograna z pliku GPX). Użyj `Full sync`. |
| Plugin nie pojawia się na liście | Sprawdź, czy jest `main.js` (`npm run build`) i czy `id` w `manifest.json` zgadza się z nazwą folderu. |
