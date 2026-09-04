# Profesjonalna architektura wiedzy dla agenta AI tworzącego menu

## Kompleksowe wyniki researchu i blueprint wdrożenia w NotebookLM

---

## Wprowadzenie

Ten research syntetyzuje profesjonalną wiedzę kulinarną z zakresu menu engineeringu, nauki o smaku, technik kulinarnych, kuchni regionalnych, kompozycji dań, psychologii gościa oraz architektury bazy wiedzy. Dokument jest zbudowany tak, aby można go było bezpośrednio zakodować w agencie AI do tworzenia menu obsługiwanym przez Head Chefa. Tam, gdzie dana informacja powinna być traktowana jako wytyczna, a nie twarda reguła, zostało to wyraźnie oznaczone. Ostatnia sekcja zawiera konkretny blueprint podziału NotebookLM wraz z dokumentami źródłowymi, które powinny zasilić każdy notatnik.

---

## 1. Menu engineering i projektowanie menu według typu lokalu

### 1.1 Bazowe frameworki

Pod każdym menu generowanym przez agenta powinny leżeć dwa frameworki analityczne:

- **Macierz Menu Engineering Kasavana-Smith (1982)**: klasyfikuj każdą pozycję według popularności i marży kontrybucyjnej na Stars, Plowhorses, Puzzles i Dogs. Stars to wysoka popularność i wysoka marża. Plowhorses to wysoka popularność i niska marża. Puzzles to niska popularność i wysoka marża. Dogs to niska popularność i niska marża. Agent powinien zwracać nie tylko dania, ale też przewidywany kwadrant macierzy oraz "dźwignię" używaną przy ich projektowaniu, na przykład składnik premium, niskokosztowy crowd-pleaser itd.
- **Zasady psychologii menu**: efekt pozycji seryjnej, czyli recency/primacy w kolejności sekcji; paradoks wyboru, czyli mniejsze menu lepiej konwertuje; semantyczna wyrazistość, czyli opisowy język zwiększa sprzedaż opisywanej pozycji; wzorce ruchu oczu, czyli prawa górna część dwustronicowego menu oraz pierwsze i ostatnie pozycje list; ramki i wyróżnienia; efekt wabika dla cen premium; psychologia formatu ceny, czyli usuwanie znaku waluty i końcówki .00 oraz unikanie kolumnowego wyrównywania cen, które zmienia menu w cennik. Menu engineering i psychologia menu zostały najpierw usystematyzowane przez Seaberga, a następnie zoperacjonalizowane przez Kasavanę i Smitha.

### 1.2 Menu bistro - swobodnie, ale z klasą

- **Rozmiar**: celowo ograniczony - zwykle 6-10 przystawek, 8-12 dań głównych, 4-6 deserów oraz 2-4 dania dnia / du jour. Sama powściągliwość jest sygnałem pewności bistro.
- **Struktura sekcji**: przystawki / zupy i sałatki / dania główne, dalej dzielone na przykład na "z lądu" i "z morza" albo według techniki gotowania / dodatki à la carte / sery / desery. Krótka karta win z regionalnym charakterem, często mocno oparta na winach na kieliszki.
- **Architektura cenowa**: kotwica "good-better-best" w każdej sekcji - danie luksusowe umieszczone obok opcji ze środka cenowego i opcji przystępnej, aby premium wydawało się osiągalne, a nie onieśmielające. Desery powinny być krótkie i emocjonalne: nostalgia i komfort ponad pokaz techniki.
- **Filozofia**: sycące dania z lokalnych, sezonowych składników; porcje umiarkowane; ręcznie pisana tablica z daniami dnia. Format: zwykle pół letter albo letter, pojedyncze złożenie, często z pismem odręcznym albo rustykalną typografią.
- **Logika operacyjna**: każde danie musi współdzielić przynajmniej jeden komponent mise-en-place z innym daniem w menu, aby linia mogła spokojnie pracować w szczycie.

### 1.3 Menu restauracji casual / mid-range

- **Rozmiar**: 12-18 przystawek / dań do dzielenia, 12-20 dań głównych, 5-8 deserów; menu szersze, aby obsłużyć rodzinne jedzenie i szerszą demografię.
- **Podział sekcji**: przekąski i bar bites / przystawki / sałatki / zupy / pasta albo zboża, jeśli pasuje / dania główne według kategorii białka: Morze, Ląd, Ogród / dodatki / desery / dziecięce, jeśli dotyczy.
- **Poziomy cenowe**: zbuduj trzy poziomy w każdej kategorii dań głównych, na przykład 18 / 26 / 38. Poziom środkowy powinien mieć najwyższą marżę kontrybucyjną; menu engineering powinien zaprojektować środek jako "Star".
- **Strategia dań dnia**: funkcje: rotacja zapasów, eksperymentowanie ze składnikami, czyli R&D dla kandydatów do stałego menu, oraz sposób dodawania narracji i świeżości bez drukowania nowych kart. Typowa kadencja: 2-3 lunch specials i 3-4 dinner specials, odświeżane tygodniowo z jednym wyjątkiem dziennym, na przykład Catch of the Day.
- **Rotacja sezonowa**: 4 rotacje rocznie: wiosna, lato, jesień, zima. Rotacja około 30-40% menu przy ochronie "signature anchor dishes", czyli 5-8 pozycji definiujących tożsamość marki, których nie wolno usuwać.

### 1.4 Restauracja high-end, czyli nowoczesny upscale

- **Mieszany format**: zwykle dwutorowy - 5-7-daniowe menu degustacyjne szefa w formule prix fixe równolegle z ciasno skomponowanym 4-daniowym à la carte: 3-5 przystawek, 4-6 dań głównych, 3-4 desery.
- **Filozofia amuse-bouche**: jeden kęs, gratisowy, zaprojektowany po to, aby: a) zasygnalizować głos szefa, b) pobudzić ślinienie, c) zapowiedzieć sezon lub temat. Nigdy nie powinien powtarzać smaku ani techniki, która pojawia się później w posiłku.
- **Progresja dań**: od lżejszych do cięższych; od chłodniejszych do cieplejszych, z jednym zimnym punktem zwrotnym, na przykład crudo; surowe → peklowane / curing → poached → seared → roasted → braised. Dania kwaśne bezpośrednio po tłustych; gorzkie przed słodkimi, aby podbić percepcję słodyczy.
- **Wine pairing**: zintegrowany, nie doklejony. Dwie ścieżki pairingu, klasyczna i odważniejsza / wybór sommeliera, pozwalają agentowi określić obie.

### 1.5 Fine dining - wielodaniowe menu degustacyjne, 8-16 dań

Kanoniczna struktura rozszerzonego tasting menu. Agent powinien traktować ją jako elastyczny szkielet, nie jako regułę:

1. **Hors d'oeuvre / Snack** - jeden albo kilka "kęsów" serwowanych na stojąco albo z koktajlami.
2. **Amuse-bouche** - prezent od szefa; ustawia temat.
3. **Zimne otwarcie** - crudo, tatar albo chłodna kompozycja warzywna.
4. **Zupa** - klarowna / lekka, na przykład consommé, baza dashi albo esencja warzywna, a nie ciężki bisque, który należy rezerwować dla bogatszych narracji.
5. **Pierwsze danie wytrawne** - często showcase warzywny. We współczesnym fine diningu warzywa zajmują dziś prestiżową pozycję.
6. **Ryba / owoce morza** - delikatne białko, umiarkowana ciężkość.
7. **Pasta / zboże / jajko** - opcjonalnie w menu o wpływach włoskich albo w dłuższych menu.
8. **Palate cleanser** - sorbet, granita albo zimna infuzja resetująca podniebienie.
9. **Główne białko** - najbogatszy, najbardziej kaloryczny punkt centralny: czerwone mięso, dziczyzna albo solidny ekwiwalent warzywny.
10. **Ser** - danie pomostowe; trzy sery według typu mleka: krowie / kozie / owcze oraz tekstury: miękki / półtwardy / blue.
11. **Pre-dessert** - owocowy, kwasowy, lekki.
12. **Dessert** - czekolada albo bogatsza konstrukcja.
13. **Mignardises / Petit fours** - 3-5 małych słodkości do kawy / herbaty / digestifu.

**Tempo**: 10-15 minut między daniami; łącznie 2,5-4 godziny. Agent powinien generować timing per danie oraz obciążenie stacji kuchennych, czyli które dania wychodzą z cold / garde-manger, które z hot line, a które z pastry, aby menu było realnie wykonalne operacyjnie.

**Łuk narracyjny**: pięć częstych archetypów, spośród których agent powinien wybierać: *Sezonowa Podróż* - jeden sezon i składniki w piku; *Terroir Miejsca* - spiżarnia jednego regionu; *Wspomnienie Szefa* - autobiograficzne; *Showcase Jednego Składnika* - każde danie pokazuje ten sam hero ingredient, na przykład pomidor albo kaczka; *Konceptualne* - kolor, technika albo tekstura jako wspólna nić, w stylu Alinea albo El Bulli.

**Palate cleansers**: przynajmniej jeden na każde 6 dań; używaj elementów gorzkich, na przykład Campari granita, kwaśnych, na przykład yuzu sorbet, verjus, albo ściągających, na przykład zielona herbata, shiso, zamiast słodkich, bo słodkie cleansers stępiają kolejne dania.

**Petit fours**: tradycyjnie 3-5 pozycji różniących się techniką: jedna czekoladowa, jedna owocowy żel / pâte de fruit, jedna orzech / karmel, jedna cytrusowa, jedna ciepła, jeśli pozwala logistyka.

### 1.6 Menu eventowe

**Menu canapé / finger food** - reguły ilościowe zaczerpnięte z profesjonalnej praktyki cateringowej:

| Typ wydarzenia | Sztuki na osobę |
|---|---:|
| Cocktail hour przed posiłkiem, po którym jest kolacja | 3-5 |
| 1-2 godz. drinks reception, bez kolacji | 5-8 |
| Stand-up reception, 2-4 godz., bez lekkiej kolacji | 8-10 |
| Canapés jako cały posiłek, 3+ godz. | 10-15 |

- **Proporcja hot/cold**: 50/50 to bezpieczny default; venue bez gorącej kuchni może przesunąć się do 70/30 z przewagą zimnych. Branżowa reguła, gdy serwowane jest słodkie canapé: mniej więcej 1 słodkie na 4 wytrawne.
- **Architektura różnorodności**: minimum obejmuje mięso / drób / rybę albo owoce morza / vegetarian / vegan / gluten-free. Przy eventach wyłącznie canapé słodkie canapés są obowiązkowe na zamknięcie.
- **Dyscyplina bite-size**: każde canapé musi dać się zjeść w 1-2 kęsach jedną ręką; bez kapania; strukturalnie stabilne przez 20 minut na tacy kelnerskiej. Verrines, czyli canapés w kieliszkach / shot glass, liczą się jako 1 sztuka na osobę podczas reception i 2 sztuki na osobę przy lunchu / posiłku finger-food.

**Menu weselne** - cztery formaty, które agent powinien obsługiwać:

1. *Wielodaniowe formalne plated menu* - 4-6 dań, wybór 2 dań głównych wybranych wcześniej przez gościa; opcje vegetarian i gluten-free zawsze budowane równolegle do głównego menu, a nie jako dodatek po fakcie.
2. *Buffet / grazing* - 3 gorące dania główne, 2 zimne dania główne, 4-6 dodatków, sałatki, pieczywo, stacja deserowa; kalkulacja porcji 1,25× względem plated z powodu waste i overservingu.
3. *Family-style / passed platters* - ulubiony format włosko-amerykańskich i nowoczesnych wesel; 1,5× porcji plated; każda półmiskowa porcja obsługuje 6-8 osób.
4. *Cocktail reception ze stacjami* - 5-6 stacji: carving station, live station z pastą lub risotto, raw bar, slider / handheld station, stacja wegetariańska, stacja deserowa.

**Menu eventów korporacyjnych** - nastawienie na inkluzywność dietetyczną, założenie, że 30% osób ma ograniczenie, szybsze czasy serwisu, konserwatywniejsze profile smakowe i widoczne etykietowanie. Bufety lunchowe kalibrowane na 45-minutowe okna: przygotuj 10-20% ponad headcount na bezpieczne pozycje i 5% ponad na pozycje bardziej odważne.

**Menu eventów sezonowych** - agent powinien posiadać kalendarz kulturowych i sezonowych kotwic, takich jak Lunar New Year, Diwali, Iftar / Ramadan, Wielkanoc, Pesach, Thanksgiving, Boże Narodzenie, Midsummer, Día de los Muertos, wraz z archetypami dań i składnikami zakazanymi / wymaganymi, na przykład bez wieprzowiny przy eventach istotnych dla halal, bez zakwaszania / leavening przy posiłkach pesachowych.

### 1.7 Strategia rotacji menu

- **Kwartalne rotacje sezonowe** - 4× rocznie z pełnym refresh menu; **miesięczne "sub-rotacje"** 1-2 specials i lineup mignardises deserowych; **tygodniowe du jour** dla pozycji o dużej rotacji.
- **Ochrona signature dish**: zdefiniuj 4-8 "anchor SKUs", które przetrwają każdą rotację. One są marką. Rotuj technikę albo garnish sezonowo, żeby utrzymać aktualność bez alienowania powracających gości.
- **Regionalne kalendarze składników**: agent musi mieć kalendarze produktów dla konkretnych szerokości geograficznych: umiarkowana półkula północna, śródziemnomorska, równikowa, półkula południowa oraz wytyczne dotyczące skorupiaków i małży według "miesięcy z R".
- **Rotacja 80/20**: 80% menu rotuje sezonowo; 20%, czyli anchors, zostaje stałe. To praktyka operacyjna większości nowoczesnych bistro i casual fine-dining.

---

## 2. Koło smakowe i nauka o łączeniu smaków

### 2.1 Pięć podstawowych smaków - i trzy dodatkowe

- **Słodki, kwaśny, słony, gorzki, umami** to pięć uznanych smaków.
- **Umami** (Ikeda, 1908) jest wykrywane przez receptory glutaminianu i działa na większym obszarze języka niż pozostałe smaki; utrzymuje się dłużej po przełknięciu, co jest jego cechą definicyjną. Klasyczna trifecta umami to glutaminian + inozynian z mięsa / ryb + guanylan z grzybów. Działają synergicznie, a nie addytywnie.
- **Kokumi** jest coraz częściej akceptowane jako szósta percepcja. Nie jest smakiem samym w sobie, lecz *modulatorem* - najpierw wzmacnia umami, potem słodkość i tłuszcz, w mniejszym stopniu sól. Jest mediowane przez receptory wapniowe CaSR oraz receptor GPRC6A; wyzwalane przez peptydy γ-glutamylowe, takie jak glutation i γ-Glu-Val-Gly. Naturalnie obfite w długo dojrzewających serach, czosnku, przegrzebkach, sosie rybnym, sosie sojowym, miso, wolno gotowanych bulionach oraz grzybach shimeji / maitake. Deskryptory sensoryczne: *gęstość, pełnia w ustach, ciągłość, okrągłość, trwałość*. Praktyczna implikacja dla projektowania menu: aby ograniczyć sól, cukier lub tłuszcz bez utraty odczuwanej bogatości, zwiększ źródła kokumi.
- **Tłuszcz jako smak**: istnieją już mocne dowody na smak tłuszczu mediowany przez CD36 obok teksturalnego mouthfeel tłuszczu. Zarówno pre-, jak i post-ingestive sensing tłuszczu wpływa na sytość i palatability.
- **Wrażenia trigeminalne** - technicznie nie są smakami: pikantność / heat, czyli kapsaicyna; chłodzenie, czyli mentol, mięta; mrowienie / drętwienie, czyli pieprz syczuański - *má*; cierpkość / astringency, czyli taniny, persymona, niedojrzałe orzechy włoskie; karbonizacja; pungency, czyli olejek gorczyczny, izotiocyjanian allilu z chrzanu.
- **Wpływ temperatury na percepcję smaku**: percepcja słodyczy osiąga szczyt około 35°C, czyli przy temperaturze ciała; zimno przytępia słodycz i gorycz, wyostrza kwaśność i słoność; gorące dania wydają się bardziej umami-forward. Doprawiaj dania zgodnie z tym - desery, które będą stygnąć, powinny być *przesłodzone* w temperaturze pokojowej; zimne zupy powinny być agresywnie doprawione.

### 2.2 Hipoteza Foodpairing i metodologia

- Powstała dzięki François Benziemu z Firmenich, spopularyzowana przez Bernarda Lahousse'a, Petera Coucquyta i Johana Langenbicka z Foodpairing.com; przełomowa książka: *The Art and Science of Foodpairing* (2020).
- **Główna hipoteza**: składniki dzielące kluczowe lotne związki aromatyczne mają tendencję do dobrego łączenia się. Około 80% doświadczenia smaku pochodzi z węchu.
- **Metodologia**: chromatografia gazowa sprzężona ze spektrometrią mas GC-MS profiluje lotne związki każdego składnika; algorytm punktuje połączenia według wspólnych kluczowych aromatów ważonych progiem percepcji. Baza danych przekracza dziś 3000 składników.
- **Słynne "odkryte" połączenia**: biała czekolada + kawior (trimetyloamina), truskawka + bazylia (cynamonian metylu), czekolada + blue cheese (73 wspólne związki), banan + pietruszka, kalafior + kakao, ostryga + kiwi.
- **Ważne zastrzeżenie naukowe**: artykuł z 2011 roku w *Scientific Reports* (Ahn et al., "Flavor network and the principles of food pairing") wykazał, że kuchnie zachodnie rzeczywiście mają tendencję do łączenia składników współdzielących związki aromatyczne, ale **kuchnie wschodnioazjatyckie celowo robią odwrotnie - unikają składników współdzielących związki**. Dlatego teoria shared-compound jest *jedną* heurystyką projektową, a nie uniwersalnym prawem. Agent musi obsługiwać oba tryby.

### 2.3 Rodziny związków aromatycznych - prymitywy pairingowe agenta

- **Estry** - owocowe, słodkie, tropikalne: banan, ananas, dojrzała gruszka, rum, fermentowane ciasto.
- **Terpeny i terpenoidy** - sosna, cytrusy, zioła: cineol w rozmarynie, limonen cytrusów, chmiel, jałowiec, kardamon.
- **Związki siarki** - allium, kapustne, kawa, owoce tropikalne w śladowych ilościach, np. passionfruit, fermentowane owoce morza DMS, trufla bis(methylthio)methane.
- **Pirazyny** - prażone, orzechowe, ziemiste: produkty Maillarda, palona kawa, kakao, pieczona papryka, pieczone mięsa.
- **Laktony** - kremowe, kokosowe, brzoskwiniowe: brzoskwinia, morela, kokos, masło, alkohole dojrzewane w dębie.
- **Aldehydy** - zielone, tłuszczowe, skórka cytrusowa: ogórek, świeża ryba, zest cytrusowy, benzaldehyd migdałowy.
- **Fenole i gwajakole** - dymne, medyczne, waniliowe: produkty wędzone, whisky, wanilina, eugenol z goździków.
- **Geosmina** - ziemista / petrichor: buraki, ryby słodkowodne, grzyby, gleba po deszczu; pomost między burakami a Sauvignon Blanc.

### 2.4 Flavor bridging

Gdy dwa pożądane składniki nie dzielą związków, połącz je trzecim składnikiem "pomostowym", który dzieli związki z każdym z nich. Przykład roboczy: *truskawka + parmezan* nie mają wiele wspólnego; *dojrzały balsamic* dzieli estry z truskawką i Maillard / umami z parmezanem, więc pomostuje tę parę. *Foie gras + kakao* są pomostowane przez *redukcję z porto*, która łączy laktony z tłuszczem foie i pirazyny z kakao. Agent powinien umieć zapytać "znajdź bridge między X i Y" względem swojej bazy związków.

### 2.5 Kontrast kontra komplementarność

- **Pairing komplementarny** - ta sama rodzina smakowa pogłębia się: grzyb + trufla + beurre noisette; pomidor + bazylia + oliwa.
- **Pairing kontrastowy** - przeciwieństwa stymulują podniebienie: foie gras + kwaśny owoc; tłusta ryba + jasny cytrus; boczek / pork belly + kwaśna wiśnia; sól + karmel.
- **The Flavor Bible** (Page & Dornenburg, 2008; James Beard Award 2009) to podstawowe źródło agenta dla empirycznie potwierdzonych pairingów - alfabetyczne hasła składników z pogrubionymi "matches made in heaven", uchwycające konsensus dziesiątek topowych chefów z USA. Książki towarzyszące *Culinary Artistry*, *The Vegetarian Flavor Bible* i *What to Drink with What You Eat* powinny znaleźć się w stałej bibliotece referencyjnej agenta.

### 2.6 Regionalne "sygnatury" smakowe - presety regionalnych palet agenta

- **Klasyczna europejska / francuska**: masło, śmietana, wino, szalotka, demi-glace; oś estragon-trybula-pietruszka; głębia Maillarda; kwasowość gotowana, czyli redukcje, ponad surową kwasowość.
- **Włoska**: oliwa, czosnek, anchois, pomidor, bazylia, parmezan; składniki surowe albo krótko gotowane; mało nachodzących na siebie smaków w jednym daniu, czyli zasada "mniej znaczy więcej" przypisywana Marcelli Hazan.
- **Śródziemnomorska / Lewantyńska**: oliwa, cytryna, sumak, za'atar, mięta, pietruszka, kumin, tahini, melasa z granatu.
- **Azja Południowo-Wschodnia - tajska, wietnamska, malezyjska, indonezyjska**: jednoczesna równowaga sweet-sour-salty-spicy-bitter-umami w jednym daniu; trawa cytrynowa, galangal, liść kaffiru, sos rybny, cukier palmowy, tamarynd, bird's-eye chili, kokos.
- **Azja Wschodnia - chińska, japońska, koreańska**: soy / tamari, sezam, trójca imbir-szczypior-czosnek, fermentowane pasty fasolowe: doubanjiang, gochujang, doenjang; ocet ryżowy. Kuchnie wschodnioazjatyckie charakteryzują się unikaniem pairingów opartych na współdzielonych związkach, według Ahn et al.
- **Subkontynent indyjski**: temperowane przyprawy, czyli tadka / chaunk, regionalne warianty garam masala, ghee, jogurt, tamarynd, asafetyda, liść curry. Podział regionalny: nabiał i sosy pomidorowo-cebulowe na północy; kokos, gorczyca, liść curry i tamarynd na południu; olej gorczycowy i panch phoran w Bengalu.
- **Bliski Wschód**: ciepłe mieszanki przypraw: baharat, ras el hanout, advieh, dukkah, za'atar; tahini, jogurt, suszona limonka loomi, róża, szafran, sumak. Baharat ≠ ras el hanout ≠ za'atar - agent musi utrzymywać je jako odrębne kategorie, patrz §5.7 niżej.
- **Ameryka Łacińska / Meksyk**: suszone chile: ancho, mulato, pasilla, guajillo, chipotle, chile de árbol; kukurydza nixtamalizowana; tomatillo, limonka, kolendra, epazote, hoja santa, czekolada w mole. Samo mole ma siedem kanonicznych odmian oaxakańskich.
- **Nordycka / New Nordic**: elementy foraged: mech, porosty, sosna, rokitnik, jałowiec, szczaw, ramps, marzanka wonna; ryby konserwowane: curing, smoking; kulturowany nabiał; fermentacja we wszystkich kategoriach: lacto-pickling, miso / koji, garum, ocet.
- **Afrykańska subsaharyjska**: berbere, harissa - północnoafrykańska, peri-peri, peanut / groundnut, palm nut, plantain, yams, scotch bonnet, kolendra, fermentowana fasola locust bean, czyli iru / dawadawa.

### 2.7 Jak topowi chefowie podchodzą do pairingów

- **Grant Achatz (Alinea, Chicago)** - emocjonalne i konceptualne triggery; używa compound matchingu w stylu Foodpairing obok teatralnego, multisensorycznego platingu: jadalny balon, deser malowany przy stole na silikonowej macie. Wskazuje *Culinary Artistry* jako swoją najczęściej używaną książkę kucharską.
- **Heston Blumenthal (The Fat Duck)** - multisensoryczna percepcja, czyli dźwięk i aromat w doświadczeniu kolacji, historyczny research brytyjski, np. średniowieczne książki kucharskie, oraz bezpośrednia współpraca z naukowcami od żywności. "Meat Fruit" - parfait z wątróbki drobiowej udające mandarynkę - jest przykładem disguise / surprise.
- **René Redzepi (Noma, Kopenhaga)** - terroir-first, oparty na foragingu; laboratorium fermentacji Nomy, przez lata prowadzone przez Davida Zilbera, zinstytucjonalizowało lacto-ferments, koji, garums, shoyus, kombuchas, vinegars oraz "black" długo fermentowane owoce i warzywa jako prymitywy smakowe. Książka *The Noma Guide to Fermentation* (2018) jest kanonicznym źródłem.
- **Massimo Bottura (Osteria Francescana)** - konceptualna reinterpretacja włoskiej tradycji: "Oops, I dropped the lemon tart"; "Five Ages of Parmigiano-Reggiano in Different Textures and Temperatures"; pairingi zakorzenione w regionalnym włoskim kanonie, ale zdekonstruowane.

---

## 3. Tekstura i struktura w kompozycji dania

### 3.1 Słownik tekstur

Każde skomponowane danie powinno świadomie zawierać przynajmniej trzy z tych tekstur, w tym przynajmniej jedną parę kontrastującą:

- Crispy - kontrolowana kruchość pod naciskiem zębów: smażony tuile, crackling
- Crunchy - utrzymana ziarnistość / chrupkość: orzechy, granola, smażona szalotka
- Creamy - gładkie, tłuszczowe: purée, mus, ganache
- Silky - gładkie płynne: velouté, beurre blanc
- Chewy - sprężyste: dobrze ugotowane zboża, ośmiornica, ścięgno
- Airy - piana, espuma, soufflé
- Gelatinous - żele, panna cotta, terriny
- Powdery - proszki maltodekstrynowe, liofilizowane pyły
- Brittle - odłamki karmelu, isomalt
- Springy / bouncy - fish balls, mochi, skórki tofu

### 3.2 Nauka o mouthfeel

- **Lepkość** jest odbierana niezależnie od smaku, ale wysoka lepkość spowalnia uwalnianie aromatu. Dlatego lody potrzebują więcej cukru niż sorbet, aby smakować równie słodko.
- **Cierpkość / astringency** to trigeminalne wrażenie wiązania białek: taniny wytrącają białka śliny. Oczyszcza podniebienie z tłuszczu i dlatego czerwone wino łączy się z tłustymi mięsami.
- **Pikantność** kapsaicyny to odpowiedź bólowa receptora TRPV1; narasta, a nie tępieje przy powtarzanej ekspozycji w trakcie posiłku - grupuj pikantne dania albo rozdzielaj je szeroko.
- **Chłodzenie** mentolu i eukaliptusa to TRPM8 i pięknie kontrastuje z bogatym tłuszczem.
- **Trigeminalne drętwienie** hydroxy-α-sanshool z pieprzu syczuańskiego tworzy *má* w *má-là*; przygotowuje percepcję kapsaicyny.

### 3.3 Kontrast temperatury w projektowaniu dań

Jedna skomponowana płyta często zyskuje dramatyzm dzięki dwóm, a nawet trzem temperaturom: ciepły obsmażony przegrzebek na chłodnej sałatce z surowych warzyw z mrożonym cytrusowym śniegiem; ciepła zupa nalewana przy stole na zimny komponent. Kontrast temperatury wydłuża też zaangażowanie sensoryczne i zapobiega zmęczeniu podniebienia.

### 3.4 Struktura wizualna i zasady platingu

- **Liczby nieparzyste** - 3 albo 5 komponentów / garnishy wygląda na skomponowane; liczby parzyste wyglądają na sparowane albo przypadkowe.
- **Wysokość** tworzy punkty ogniskowe; buduj wertykalnie przeciw grawitacji płaskiego sosu.
- **Negatywna przestrzeń** - zostaw 30-50% talerza widoczne; zatłoczone talerze czytają się jako tanie.
- **Teoria koloru** - pożyczaj z malarstwa: pary komplementarne, na przykład czerwony burak + zielony olej pietruszkowy; tony analogiczne, na przykład marchew / dynia / kurkuma monochromatycznie; jeden kontrastowy akcent. Białe talerze pozostają domyślnym płótnem; matowa czerń wzmacnia zieleń i czerwień; szorstka ceramika sugeruje rustykalność i fermentację.
- **Eye-flow** - oko gościa skanuje od lewego dołu do prawej góry; punkt ogniskowy należy umieścić w prawym górnym przecięciu wyobrażonej siatki trójpodziału.
- **Aplikacja sosu** - swoosh, smear, dot, pool i emulsion drizzle; wybierz jedną technikę podpisową dla dania. Nie mieszaj stylów sosowania.
- **Style platingu** - agent powinien świadomie wybrać jeden dla każdego konceptu: tradycyjny / clock-face, protein o 6:00, starch o 10:00, vegetable o 2:00; trio; linear; controlled randomization; landscape; deconstructed; monochromatic; free-form.

### 3.5 Filozofia "complete bite"

Wywodzi się z tradycji Thomasa Kellera / Per Se / The French Laundry: każdy kęs powinien zawierać każdy kluczowy element dania w proporcji zbliżonej do całości. Oznacza to unikanie izolowanych garnishy, których gość nie może łatwo zabrać widelcem razem z białkiem, oraz unikanie kałuż sosu, w których trzeba "łowić". Test: jedna porcja na widelcu zawiera przynajmniej po jednym elemencie z białka, skrobi / zboża, jeśli występuje, warzywa, sosu i komponentu teksturalnego.

### 3.6 Nowoczesne techniki teksturalne

Agent powinien umieć jawnie wywołać każdą z tych technik:

- **Foams / espumas / airs**: płyn + stabilizator: xanthan gum 0,2-0,8%, lecytyna, Versawhip → ubijanie, blendowanie albo ładowanie N₂O w syfonie iSi.
- **Żele**: hot gels: gellan, agar-agar, które ustawiają się powyżej 35°C i są freeze-stable; cold gels: żelatyna; elastic gels: iota carrageenan; brittle gels: kappa carrageenan, methylcellulose. Fluid gels = ścięte żele ścinane mechanicznie do zachowania płynnego.
- **Sferyfikacja**: *direct* - alginian sodu w bazie smakowej 0,5-1% wkraplany do kąpieli z mleczanem wapnia albo chlorkiem wapnia; pęka pod zębem. *Reverse* - baza bogata w wapń do kąpieli alginianowej; trwalsze, większe perły, możliwe do podania na ciepło. Spopularyzowane przez Ferrana Adrię w El Bulli w 2003 roku.
- **Proszki**: maltodekstryna tapiokowa zamienia tłuszcz - oliwę, beurre noisette, tłuszcz z bekonu - w proszek.
- **Crisps i tuiles**: glukoza-isomalt do przezroczystych shardów; dehydracje nori-cracker; potato albo pasta crisp z użyciem xanthan + flour.
- **Sous vide**: precyzyjne gotowanie niskotemperaturowe w zamkniętych woreczkach: białka 49-63°C dla medium-rare envelope; warzywa 83-85°C dla zachowanej chrupkości przy pełnym rozpadzie pektyn.
- **Kompresja próżniowa** w pakowarce komorowej: infuzuje owoce syropami ziołowymi, "kompresuje" arbuza do tekstury podobnej do tuńczyka, przyspiesza marynowanie.
- **Syfon do bitej śmietany**: szybkie infuzje, szybkie pikle, piany gorące lub zimne, karbonizacja owoców.
- **Anti-griddle / ciekły azot**: natychmiastowe zamrażanie pian i purée dla "mrożonych proszków" oraz błyskawicznie zamrożonych powierzchni z płynnym środkiem.
- **Dehydracja i liofilizacja**: koncentracja smaku, zachowanie koloru, generowanie crisp textures i stabilnych półkowo proszków.

Źródła referencyjne: *Modernist Cuisine* (Myhrvold / Bilet); *Modernist Cuisine at Home*; *Cooking for Geeks*; *Ideas in Food*; *Modernist Cooking Made Easy* (Logsdon).

---

## 4. Fundamentalne techniki kulinarne - klasyczne i nowoczesne

### 4.1 Pięć francuskich sosów matka według kanonu Escoffiera

Definitywnie skodyfikowane w *Le Guide Culinaire* (1903), rozwinięte z wcześniejszych czterech Carême'a. Ścisłe opracowania historyczne zauważają, że hollandaise był pierwotnie "petite sauce"; angielskie wydanie z 1907 roku utrwaliło współczesną piątkę.

| Sos matka | Baza | Zagęstnik | Kluczowe sosy pochodne |
|---|---|---|---|
| **Béchamel** | Mleko | Biała zasmażka | Mornay (Gruyère), Soubise (purée z cebuli), Nantua (masło rakowe), sos musztardowy, sos cheddar, Crème, Aurore (z pomidorem) |
| **Velouté** | Biały stock: kurczak / cielęcina / ryba | Blond roux | Suprême (śmietana + stock drobiowy), Allemande (żółtko + cytryna), Bercy (szalotka + białe wino), Normande (fish velouté + cream + egg), Poulette, Vin Blanc |
| **Espagnole** | Brown stock: cielęcina / wołowina | Brown roux + pomidor | Demi-glace (espagnole + brown stock zredukowany o 50%), Bordelaise (czerwone wino + szpik), Chasseur (grzyb + szalotka + białe wino), Robert (musztarda), Madeira, Diable, Bourguignonne, Lyonnaise, Africaine, Charcutière |
| **Tomate** | Pomidor + wieprzowina + mirepoix | Roux klasycznie albo redukcja | Provençale, Portuguese, Creole, Bolognese (z rumienionym mięsem + sofrito), Marinara, Puttanesca |
| **Hollandaise** | Masło klarowane | Emulsja żółtkowa, bez roux | Béarnaise (estragon + redukcja szalotkowa), Choron (béarnaise + pomidor), Foyot / Valois (béarnaise + meat glaze), Maltaise (blood orange), Mousseline (bita śmietana), Noisette (beurre noisette), Paloise (mięta) |

Niektóre współczesne teksty zaliczają **majonez** jako szósty, zimny sos matka - pochodne to aïoli, rouille, tartare, rémoulade i Marie Rose, czyli cocktail sauce.

### 4.2 Stocki i buliony - proporcje i czas

- **White stock (Fond Blanc)**: kości niepieczone, krótko blanszowane w celu usunięcia zanieczyszczeń, gotowane bardzo wolno z white mirepoix, gdzie marchew można zastąpić pasternakiem / porem, oraz bouquet garni. Cielęcina / kurczak: 6-8 godzin. Dodaje żelatyny i jedwabistego body bez koloru.
- **Brown stock (Fond Brun)**: kości pieczone około 200°C aż do głębokiego zrumienienia; mirepoix pieczone; koncentrat pomidorowy pinçaged w brytfannie; deglazowanie wodą / winem. Cielęcina / wołowina: 8-12 godzin. Dodaje głębi Maillarda i koloru.
- **Fish fumet**: kości chudych białych ryb, takich jak sola, halibut, turbot - nigdy tłuste ryby; delikatnie zeszklone z white mirepoix i białym winem; **gotuj tylko 30-45 minut**. Dłużej wyciąga gorycz / wapń.
- **Vegetable stock (Fond Maigre)**: 30-45 minut; unikaj kapustnych, bo są siarkowe, buraków, bo dominują kolorem, oraz skrobiowych korzeni, bo powodują mętność.
- **Dashi**: zimnowodna infuzja *kombu* - 60°C przez 30 minut, nigdy nie gotować - potem dodaj *katsuobushi*, czyli płatki bonito, doprowadź do minimalnego simmeru i od razu odcedź. Całość 10 minut. Agent powinien generować *ichiban* - pierwsze dashi - oraz *niban*, czyli drugie / niższej klasy dashi.
- **Consommé**: klarowany stock przez raft: białka jaj + mielone mięso + kwaśne mirepoix; delikatny simmer 1,5 godziny; cedzenie przez muślin. Powinno być krystalicznie klarowne.
- **Bone broth** - współczesne określenie potoczne: w istocie długo gotowany stock 12-48 godzin z celową ekstrakcją żelatyny; pozycjonowanie żywieniowe.
- **Proporcje mirepoix**: klasyczne francuskie = 50% cebuli / 25% marchewki / 25% selera naciowego; *white mirepoix* 1:1:1:1 cebula / seler / pasternak / por dla jasnych stocków. Włoskie *soffritto* używa oliwy; hiszpańskie *sofrito* dodaje czosnek i pomidor; cajun *holy trinity* zastępuje marchew papryką; niemieckie *suppengrün* zastępuje porem.
- **Reguły kardynalne**: start w zimnej wodzie; nigdy nie gotuj gwałtownie, bo stock będzie mętny i tłusty; często szumuj przez pierwsze 30 minut; sól dodawaj na etapie gotowego dania, nigdy na etapie stocku.

### 4.3 Klasyczne techniki gotowania

Agent powinien znać wpływ każdej techniki na strukturę białka, wilgotność i rozwój związków smakowych.

- **Braising / duszenie**: zrumień, potem gotuj pod przykryciem w aromatycznym płynie, 50-80% zanurzenia, 80-95°C, 2-6 godzin. Najlepsze dla twardych, kolagenowych części: łopatka, shank, ogon wołowy, policzek wołowy. Płyn staje się sosem.
- **Poaching**: delikatne zanurzenie w płynie 70-85°C; idealne dla ryb, jaj, białych mięs i owoców. Podtypy: court bouillon / nage / shallow poaching.
- **Confit**: zasolenie / curing, potem wolne gotowanie w tłuszczu, zwykle 80-95°C, 3-10 godzin zależnie od białka; kaczka, gęś, czosnek, pomidorki cherry. Nowoczesny sous-vide confit 80°C przez 8-12 godzin jest częstym zamiennikiem.
- **Sous vide**: zamknięte próżniowo w kąpieli o dokładnej temperaturze; eliminuje overshoot carryover i daje równomierne wysmażenie od brzegu do brzegu. Standardowe temperatury białek: pierś z kurczaka 60-63°C / 1 godz.; łosoś 45-50°C / 25 min; żółtko 63°C; tenderloin wołowy medium-rare 54°C / 1-2 godz.; short rib 72 godz. w 56°C albo 24 godz. w 79°C.
- **Roasting / pieczenie**: suche środowisko, gorące powietrze dookoła, 160-230°C; rozwija exterior Maillarda i renderuje tłuszcz. Carryover 3-8°C musi być zaplanowany.
- **Grilling / broiling**: bezpośrednie promieniowanie cieplne, bardzo gorąco, 260°C+; rozwija char i pirazyny; odpoczynek mięsa jest konieczny.
- **Sautéing / pan-searing**: wysoka temperatura, cienki film tłuszczu; opiera się na suchości składnika dla Maillarda. Technika *saucier*: buduj pan sauce na fondzie po odpoczynku białka.
- **Blanching / shocking**: krótko gotuj, potem ice bath; utrwala chlorofil, zatrzymuje enzymatyczne brązowienie, częściowo gotuje przed serwisem.
- **Tempering** - czekolada, jajka, żelatyna: kontrolowane wprowadzenie jednej fazy do drugiej w kompatybilnej temperaturze, aby uniknąć zwarzenia / krystalizacji.
- **Smoking / wędzenie**: hot smoke 60-95°C, gotuje i aromatyzuje; cold smoke <30°C, tylko aromatyzuje, np. dla cured fish, sera. Dobór drewna ma znaczenie: applewood łagodne / słodkie, hickory wyraziste bacon-y, mesquite intensywne i tylko na krótko, cherry, alder - klasyczne do łososia pacyficznego.

### 4.4 Techniki nowoczesne / molekularne

- **Sous vide** - opisane wyżej: precyzja, powtarzalność, gotowość batchowa.
- **Fermentacja** - mlekowa: kraut, kimchi, miso, koji; octowa: octy, kombucha; alkoholowa: napoje, sourdough; drożdże / pleśnie: ryż koji do sake, miso, shoyu. Laboratorium Nomy spopularyzowało **garumy** - rozszerzone sosy rybne albo nawet "fish sauces" z konika polnego napędzane koji, **black garlic / black fruit** - Maillard w 60°C i 60-90% wilgotności przez tygodnie, **lacto-fruit** - 2% solanka, 3-10 dni, oraz szybkie **miso** z roślin strączkowych innych niż soja.
- **Curing**: salt cure - gravlax 12-48 godz., bacon 5-10 dni; nitrate / nitrite cure - charcuterie; equilibrium cure - nowoczesna precyzja, 2-3% soli względem łącznej wagi białka + cure.
- **Pickling**: szybki - na bazie octu, standard 1:1:1 ocet / woda / cukier; lacto-pickle - 2-2,5% soli, 3-14 dni w 18-22°C.
- **Dehydracja**: 50-70°C przez 6-24 godz.; kontrolowana aktywność wody dla chrupkich proszków, jerky, fruit leathers.
- **Kompresja próżniowa**: pakowarka komorowa przy -1 bar zapada strukturę komórkową, zwiększając gęstość / translucency i przyspieszając infuzję.
- **Techniki cryo**: anti-griddle, powierzchnia -30°C; ciekły N₂, -196°C; Pacojet, czyli mikropulweryzacja zamrożonej pasty.

### 4.5 Nauka o emulsji

- **Stabilne / permanentne emulsje**: aïoli, majonez, hollandaise - półstabilny, beurre blanc, gastrique. Stabilizowane przez surfaktanty: lecytyna żółtka, musztarda, śmietana, lecytyna sojowa, cytrynian sodu do sosów serowych, patrz Modernist Mac & Cheese.
- **Emulsje tymczasowe**: vinaigrette, pan sauce. Wymagają ponownej emulgacji przy serwisie.
- **Stabilizatory**: lecytyna, sojowa albo słonecznikowa, do pian i emulsji bez nabiału; xanthan gum 0,1-0,4% do stabilizacji o niskiej lepkości; gum arabic do klarownych emulsji; cytrynian sodu 0,5-4% do stabilizacji topionego sera bez ziarnistości; methylcellulose do pian stabilnych na ciepło.
- **Maksymalny stosunek oleju do wody** w majonezie na jednym żółtku to około 200 ml oleju na żółtko przed złamaniem emulsji; nowoczesna technika z immersion blender daje większą tolerancję.

### 4.6 Podstawy pieczywa i cukiernictwa istotne dla menu

- **Sourdough / zakwas** - naturalny leaven, 65-85% hydration, bulk ferment 4-8 godz. w 22-25°C, zimne proofowanie 8-24 godz.; smak z heterofermentatywnych LAB i drożdży. Implikacje serwisowe: 3-dniowy cykl produkcji.
- **Ciasta laminowane** - croissant, puff pastry, Danish; 27-30 warstw: 3 single + 3 single = 27 albo 4 single = 81 cienkich warstw; laminacja z blokiem masła przy temperaturze masła 14-16°C.
- **Choux / pâte à choux** - dwukrotnie gotowane ciasto; mąka gotowana w roux z wodą, potem wzbogacana jajkami; do éclairs, gougères, profiteroles.
- **Shortcrust / pâte brisée / pâte sucrée / pâte sablée** - systemy mąki pokrytej tłuszczem; pâte sucrée, czyli ciasto cukrowe, do tart; pâte sablée, czyli sandy / cookie texture, do petits fours.
- **Brioche, milk bread, focaccia** jako opcje pieczywa serwowanego w wyższej gastronomii.

### 4.7 Obróbka białek - kluczowe reakcje i liczby

- **Reakcja Maillarda**: aminokwasy + cukry redukujące → setki związków smakowych: pirazyny, furany, tiofeny; wymaga suchej powierzchni, tłuszczu i temperatury powierzchni 140°C+. Agent nigdy nie powinien zalecać obsmażania bez suchej powierzchni: osusz; nie sól podczas sear stage na mokrych białkach albo sól 45 minut wcześniej / tuż przed.
- **Carryover cooking**: pieczone białka nadal rosną o 3-8°C po zdjęciu z ognia; zdejmuj 5°C poniżej celu. Białka o większej masie overshootują bardziej.
- **Docelowe temperatury wewnętrzne** - USDA-konserwatywne; chef's-targets w nawiasie:
  - Wołowina / jagnięcina: rare 50°C (49°C), medium-rare 54°C (52°C), medium 60°C, medium-well 65°C, well 71°C.
  - Wieprzowina: 63°C z 3-minutowym odpoczynkiem, współczesny standard - różowa i bezpieczna.
  - Drób cały / nogi: 74°C; pierś: zdejmij przy 60°C dla sous vide, 68°C przy roastingu, dojdzie do 72°C.
  - Ryby: 50-55°C medium-rare; łosoś 45-48°C dla jedwabistej tekstury; tuńczyk obsmażony, surowy środek.
  - Mięso mielone: 71°C, bez marginesu bezpieczeństwa z carryover.
- **Odpoczynek**: 5-15 minut dla steków; 20-40 minut dla roastów; 1-2 minuty dla ryby. Pozwala miozynie rozluźnić się i reabsorbować soki, które termicznie przemieściły się na zewnątrz.

---

## 5. Wiedza specyficzna dla kuchni

### 5.1 Francuska kuchnia klasyczna

- **Brigade de cuisine Escoffiera**: wojskowa hierarchia organizująca produkcję kuchenną. Skodyfikowana w Savoyu i Carltonu w latach 1890. Główne stanowiska: chef de cuisine, sous chef, saucier, poissonnier, rôtisseur, grillardin, friturier, entremétier, garde-manger, pâtissier, boucher, charcutier, tournant, communard, plongeur, commis, apprentis. Nowoczesna adaptacja zwykle kondensuje się do: executive chef → sous → chef de partie według stacji → commis → stagiaire.
- **Kanon menu Escoffiera** w *Le Guide Culinaire* (1903) - ponad 5000 receptur; skodyfikował nowoczesne menu restauracyjne, oddzielił course'y, zastępując service à la française przez service à la russe, oraz wystandaryzował setki nazwanych garnishy.
- **Klasyczne garnish names** - zapamiętywać jako jednostki, bo implikują kompletne przygotowanie: *Bouquetière* - różne glazurowane warzywa; *Florentine* - szpinak + mornay; *Forestière* - grzyby + boczek + ziemniak; *Provençale* - pomidor + czosnek + pietruszka; *Niçoise* - pomidor + oliwka + anchois + fasolka szparagowa; *Bourguignonne* - czerwone wino + grzyb + lardon + cebulka perłowa; *Lyonnaise* - smażona cebula; *Dieppoise* - małże + krewetka + krem z białym winem; *Véronique* - obrane winogrona; *Doria* - ogórek; *Du Barry* - kalafior; *Crécy* - marchew; *Vichy* - krążki marchwi glazurowane w maśle i cukrze; *Clamart* - groszek; *Nantua* - rak + śmietana.
- **Klasyczny kanon**: pâté en croûte, terriny, quenelles, soufflés, vol-au-vents, coq au vin, blanquette de veau, navarin d'agneau, sole meunière, sole véronique, bouillabaisse, cassoulet, pot-au-feu, choucroute garnie.

### 5.2 Kuchnia włoska - mapa regionalna

- **Północ**: Piemont: trufle, orzech laskowy, vitello tonnato, agnolotti del plin, bagna càuda, brasato al Barolo; Lombardia: risotto alla milanese, ossobuco, bresaola, cotoletta; Veneto: risotto al nero di seppia, sarde in saor, baccalà mantecato, polenta; Emilia-Romania: Parmigiano-Reggiano, Prosciutto di Parma, ragù alla bolognese, tagliatelle, tortellini in brodo, cappelletti; Liguria: pesto genovese, focaccia, trofie, farinata.
- **Centrum**: Toskania: bistecca alla fiorentina, ribollita, pici, pappa al pomodoro; Lacjum: cacio e pepe, carbonara, amatriciana, gricia, saltimbocca; Umbria: trufle, strangozzi, porchetta.
- **Południe**: Kampania: pizza neapolitańska, spaghetti alle vongole, mozzarella di bufala, sfogliatelle, babà; Apulia: orecchiette + cime di rapa, burrata, fave e cicoria; Sycylia: pasta alla Norma, arancini, caponata, sarde a beccafico, cannoli, granita; Kalabria: nduja, peperoncino.
- **Reguły łączenia pasty z sosem** - są *ścisłe we Włoszech* i agent powinien je respektować:
  - Długie cienkie pasty: spaghetti, linguine, vermicelli → lekkie sosy olejowe / seafood / pomidorowe; carbonara, aglio e olio, vongole.
  - Długie wstęgi: tagliatelle, pappardelle, fettuccine → mięsne ragù, butter-cream, grzyby, szczególnie egg-pasta na północy.
  - Krótkie żłobione rurki: penne rigate, rigatoni, paccheri, ziti → chunky vegetable, sausage, baked dishes, czyli al forno.
  - Skręcone / zakręcone: fusilli, casarecce, busiate, trofie → pesto i chunky herb-oil sauces trzymające się rowków.
  - Pasta nadziewana: ravioli, tortellini, agnolotti, cappelletti → lekkie masło-szałwia, beurre noisette, broth / in brodo; nigdy ciężkie sosy maskujące farsz.
  - Małe kształty: orzo, ditalini, stelline → zupy, buliony.
  - Regionalne nienaruszalne pary: spaghetti carbonara, tagliatelle al ragù bolognese, orecchiette con cime di rapa, pici all'aglione, bigoli in salsa, trofie al pesto.
- **Północ kontra południe**: ciasta północne to jajko + miękka pszenica, jedwabiste, złote; południowe to durum wheat + woda, zwarte, bez jajek. Północ preferuje masło, śmietanę, cured pork fat; południe preferuje oliwę i pomidor.
- **Tradycja antipasti**: salumi, marynowane / konserwowane warzywa, sery, bruschette / crostini, seafood crudo albo marinato, formaggi misti.

### 5.3 Kuchnia japońska

- **Washoku** - niematerialne dziedzictwo UNESCO od 2013 roku, "harmonia jedzenia" oparta na strukturze *ichiju-sansai*: jedna zupa, trzy dodatki, plus ryż i pikle. Zasady definicyjne: sezonowość 旬 *shun*; pięć kolorów: biały, czarny, czerwony, żółty, zielony; pięć smaków: słodki, kwaśny, słony, gorzki, umami; pięć technik: surowe, gotowane / simmered, grillowane, smażone, parowane; pięć zmysłów.
- **Kaiseki ryori** - wielodaniowa haute cuisine wyewoluowana z ceremonii herbaty *cha-kaiseki*. Typowa sekwencja *ryōtei* kaiseki: *sakizuke* - amuse; *hassun* - sezonowa płyta ustawiająca temat; *mukōzuke* - sashimi; *takiawase* - simmered / nimono; *futamono* - miska z pokrywką, często klarowna zupa; *yakimono* - grillowane; *su-zakana* - vinegared / palate cleanser; *naka-choko* - chłodne danie podniebienia; *shiizakana* - bardziej substancjalne danie, np. hot pot; *gohan / ko-no-mono / tome-wan* - ryż + pikle + miso soup podawane razem, zamykające posiłek; *mizumono* - deser / owoce. Każde danie jest nazwane według techniki, a chef może dodawać albo pomijać elementy według sezonu i stylu.
- **Layering umami**: dashi jako baza; warstwowe elementy fermentowane: miso, soja, mirin, sake budują złożoność przez addytywną synergię glutaminianu i inozynianu.
- **Cięcia nożem / kiritsuke**: *katsuramuki* - rotacyjne obieranie daikonu w wstęgę; *sengiri* - julienne; *sasagaki* - struganie jak liść bambusa dla łopianu; *hangetsu* - półksiężyc; *icho-giri* - liść miłorzębu; *kakugiri* - kostka; *hanagiri* - cięcie kwiatowe; *usuzukuri* - papierowo cienkie sashimi z białej ryby; *hira-zukuri* - prostokątne sashimi do tuńczyka.

### 5.4 Kuchnia chińska - Osiem Wielkich Tradycji (八大菜系)

1. **Lu (Shandong)** - północna, uważana za najstarszą i najbardziej wpływową; praca na zupach, podstyl Jinan, owoce morza, podstyl Jiaodong; braising, aromaty oparte na scallion.
2. **Chuan (Sichuan)** - *má-là*, czyli drętwienie i ostrość - chili + pieprz syczuański / sanshool; doubanjiang, fermentowana pasta z bobu; mapo tofu, kung pao, fish-fragrant, czyli *yúxiāng*.
3. **Yue (Cantonese, Guangdong)** - czysty smak, świeże owoce morza, *wok hei*, czyli "oddech woka", gotowanie na parze, dim sum, char siu, white-cut chicken; lekkie doprawianie.
4. **Min (Fujian)** - wybrzeże / góry; wyrafinowane zupy, np. Buddha Jumps Over the Wall, seafood, grzyby leśne, czerwony ryż drożdżowy *hong qu*.
5. **Su (Jiangsu)** - wyrafinowanie Huaiyang; precyzyjna praca nożem; tekstury miękkie, ale nierozpadające się; lion's-head meatballs, salted duck.
6. **Zhe (Zhejiang)** - Hangzhou: West Lake fish in vinegar gravy, Dongpo pork; Ningbo: seafood; Shaoxing: rice wine.
7. **Hui (Anhui)** - dzikie zioła i game; stewing i braising; preserved / stinky tofu, hairy tofu, hairy crab.
8. **Xiang (Hunan)** - mocniejsze i bardziej bezpośrednie heat niż Sichuan, świeże chili zamiast numbing; smoking i curing; czerwono duszona wieprzowina Chairman Mao.
- **Wok hei** - powstaje dzięki bardzo wysokiej mocy BTU: 50 000-100 000 BTU w profesjonalnej kuchni kontra 10 000-15 000 w domu, stałemu podrzucaniu, które tworzy krótkie błyski Maillarda na ścianie woka, oraz olejowi osiągającemu punkt dymienia w mikromomentach.
- **Yin / Yang i Pięć Elementów** - posiłki równoważą "chłodzące" yin: gorzkie, kwaśne, wodniste, zielone / fioletowe produkty, steaming / boiling, oraz "rozgrzewające" yang: ostre / pungent, słodkie, suche, czerwone / pomarańczowe produkty, frying / grilling. Imbir-szczypior-czosnek to uniwersalna trójca.
- **Velveting** - białka marynowane w skrobi kukurydzianej + białku jaja + winie Shaoxing dla delikatnej restauracyjnej tekstury stir-fry.

### 5.5 Kuchnia tajska / Azja Południowo-Wschodnia

- **Równowaga pięciu smaków**: słodki: cukier palmowy, kokos; kwaśny: limonka, tamarynd, kaffir lime; słony: sos rybny, pasta krewetkowa; spicy: bird's-eye chili; gorzki: tajski bakłażan, gourd, liść kaffiru - subtelnie. Niektóre tradycje dodają umami, czyli sos rybny, pasta krewetkowa, jako szósty smak.
- **Fundamenty past curry** - świeże aromaty ucierane w moździerzu: chili, suszone czerwone dla *gaeng phed*, świeże zielone dla *gaeng kiao wan*, kurkuma dla południowego / żółtego; trawa cytrynowa, galangal, zest z kaffiru, korzeń kolendry, czosnek, szalotka, biały pieprz, pasta krewetkowa *kapi*; w niektórych także prażona kolendra / kumin / kardamon.
- **Layering ziół**: aromatyczna baza bloomed w kokosowej śmietance aż tłuszcz "pęknie"; białko obsmażane w perfumowanym oleju; deglazowane mlekiem kokosowym i stockiem; balansowane sosem rybnym + cukrem palmowym + limonką / tamaryndem na końcu; finish z tajską bazylią, chiffonade z liścia kaffiru i świeżym chili dla top notes.
- **Regionalna Tajlandia**: Centralna - łagodniejsze, kokosowe curry; Południowa - ostra, ognista, kurkumowa; Północna / Lanna - ziołowa, komfortowa, mniej pikantna, np. *khao soi*; Isaan - mocne, słono-kwaśne, fermentowane, np. *som tum*, *larb*, *nam tok*.
- **"Triangle rule"**: najpierw sól, potem aromatyczny olej, kwas na końcu - niezawodna sekwencja budowania smaku.
- **Wietnam, Laos, Kambodża, Birma, Filipiny, Malezja, Indonezja** mają analogiczne, ale odrębne frameworki - agent powinien utrzymywać osobne sub-profile zamiast spłaszczać je do "Southeast Asian".

### 5.6 Kuchnia meksykańska

- **Rodzina mole** - *salsas cocidas*, czyli gotowane sosy łączące suszone chile, orzechy / nasiona, przyprawy, owoce, masę albo inny zagęstnik, czasem czekoladę, w płynie. Siedem mole Oaxaki, czyli *siete moles*: negro, rojo / colorado / coloradito, amarillo / amarillito, verde, chichilo, manchamantel, estofado. Mole poblano z Puebli to wersja oparta na czekoladzie, często nazywana "daniem narodowym".
- **Fundamenty salsy**: *cruda* - surowa; *molcajeteada* - utarta w moździerzu; *tatemada / asada* - opalana / charred; *cocida* - gotowana; pico de gallo, salsa verde z tomatillo, salsa roja z pomidorem i suszonym chili, salsa macha olejowa z orzechami i suszonym chili.
- **Wiedza o chile** - świeże: jalapeño, serrano, poblano, chile de agua, habanero, manzano. Suszone: ancho z poblano, mulato z bardziej dojrzałego poblano, dymniejsze, pasilla z chilaca, guajillo z mirasol, chipotle z wędzonego jalapeño, morita, chile de árbol, chile cascabel, pasilla de Oaxaca, puya. Trójkąt suszonych chile dla wielu mole to ancho + pasilla + mulato; mole rojo często używa guajillo + puya + de árbol.
- **Wiedza o kukurydzy** - *nixtamalizacja*, czyli alkaliczne gotowanie suszonej kukurydzy z cal / lime; uwalnia niacynę, rozwija smak masy; świeża masa kontra masa harina; tortilla, tlayuda, sope, huarache, gordita, tlacoyo, tamale parowane w liściu kukurydzy albo banana, atole / champurrado.
- **Meksykańska "holy trinity"**: chile + pomidor / tomatillo + cebula + czosnek + kolendra / epazote / hoja santa.

### 5.7 Bliski Wschód

- **Struktura mezze**: otwierający krajobraz małych dipów, sałatek, pikli i chlebów - hummus, baba ghanoush / mutabal, muhammara, labneh, tabbouleh, fattoush, kibbeh, sambousek, dolmades, falafel, flatbreads. Mezze to architektura posiłku, a nie tylko przystawka - długi stół z talerzami, z którego ostatecznie wyłania się główne białko.
- **Mieszanki przypraw** - agent musi utrzymywać je jako odrębne:
  - **Baharat** - "przyprawy" po arabsku; lewantyńska i zatokowa ciepła mieszanka: czarny pieprz, kumin, kolendra, kardamon, goździk, cynamon, gałka muszkatołowa, papryka ± ziele angielskie. Podwariant: libańskie *sabaa baharat*, czyli siedem przypraw. Warianty Zatoki dodają loomi, suszoną limonkę, i szafran.
  - **Ras el hanout** - północnoafrykańska, marokańska; "najlepsze ze sklepu" - czasem 12-30+ przypraw, w tym ciepła baza baharat plus pąki róży, imbir, kurkuma, kubeba, grains of paradise, kozieradka, szafran. Bardziej ziemista i kwiatowa niż baharat.
  - **Za'atar** - lewantyńska mieszanka ziołowa: suszony tymianek / oregano / hyzop + sumak + prażony sezam + sól. Kwaśna, orzechowa, ziołowa, *nie* ciepło-słodka. Używana na labneh, manakish, pieczone warzywa.
  - **Advieh** - perska; kurkuma, cynamon, kardamon, kumin, płatek róży, suszona limonka; kwiatowa i łagodna.
  - **Berbere** - etiopska / erytrejska; chili-forward z kozieradką, ajwain, korarima, czyli false cardamom.
  - **Dukkah** - egipska; prażone orzechy + nasiona + przyprawy; jedzona z chlebem i oliwą.
  - **Hawaij** - jemeńska; kumin / kolendra / kurkuma / czarny pieprz do zup; kardamon / goździki / cynamon do kawy.
- **Sosy na bazie tahini**: tarator - tahini + cytryna + czosnek + woda; sosy tahini-jogurt; oraz building blocks hummusu i baba ghanoush.

### 5.8 Nordic / New Nordic

- **Zasady manifestu** z Nordic Cuisine Manifesto 2004: czystość, świeżość, prostota, etyka, samowystarczalność, sezonowość, integralność regionalna.
- **Foraging jako dyscyplina**: ramps, rokitnik, dzikie zioła: szczaw, bittercress, sweet cicely, woodruff, końcówki Douglas fir, pędy świerku; rośliny plażowe: sea aster, sea kale, samphire, oyster leaf; grzyby, porosty, mchy, dzikie jagody: lingonberry, cloudberry, blackcurrant.
- **Fermentacja jako technika centralna** według Nomy: *garums* z wołowiny, jagnięciny, koji-grasshopper, koji-cep; lacto-ferments; misos z żółtego grochu, orzecha laskowego, żyta; octy; black ferments w 60°C i 60+% RH, czyli długie aging alliums i owoców.
- **Filozofia konserwacji**: wędzenie, suszenie, curing, solenie, piklowanie - zachowywanie krótkiego nordyckiego sezonu na cały rok.
- **Język platingu**: naśladujący naturę, rozsypane elementy foraged, nieregularna ceramika, rustykalne drewno, mech i kamień.

### 5.9 Kuchnia indyjska

- **Tadka / chaunk / vaghar / phoran / thaalithal / oggarane** - *tempering*: bloomowanie całych przypraw w gorącym tłuszczu: ghee, olej gorczycowy, kokosowy, sezamowy, aby ich rozpuszczalne w tłuszczu aromaty przeszły do medium gotowania. **Kolejność ma absolutne znaczenie**: najpierw najstabilniejsze termicznie nasiona: gorczyca - pęka; kumin - trzaska; potem aromaty: czosnek, imbir, liście curry, suszone chili, asafetyda; potem przyprawy mielone: kurkuma, chili powder, jako ostatnie przy zmniejszonym ogniu - palą się w kilka sekund. Może być *bazą*, budowaną na początku, albo *finishem*, wylewanym na gotowy dal.
- **Regionalny dobór tłuszczu sygnalizuje pochodzenie**: ghee = północ / centrum; olej gorczycowy = wschód / Bengal / Kaszmir; olej kokosowy = południe wybrzeżne; olej sezamowy = niektóre przygotowania południowe.
- **Budowanie masali**: warstwowo - tempering całych przypraw → pocenie cebuli do głębokiego brązu → pasta imbir-czosnek → redukcja pomidora, aż olej się oddzieli, czyli *bhuna* → suche przyprawy → białko / warzywo → jogurt / śmietana / kokos → finish garam masala / kasuri methi.
- **Warianty garam masala**: punjabi: kardamon / cynamon / goździk / pieprz / bay / gałka / mace; bengalskie *garam masala*: tylko kardamon / cynamon / goździk, mielone; *panch phoran*: bengalska pięcioprzyprawowa mieszanka: koper włoski, kozieradka, kumin, czarnuszka, gorczyca; *chaat masala*: kwaśno-wytrawna z amchur i czarną solą; *sambar masala*: południowoindyjska do sambaru.
- **Regionalna architektura thali**:
  - *Punjabi thali*: dal makhani, danie paneer, rajma, sabzi, jeera rice, naan / paratha, raita, achar, sałatka, gulab jamun.
  - *Gujarati thali* - wegetariańskie, słodsze: dal, kadhi, 2-3 sabzi, kathol - lentil / bean, rotli / thepla, ryż, kachumber, athanu - pikle, shrikhand albo jalebi.
  - *South Indian / Kerala thali* - sadya na liściu banana: ryż + sambar + rasam + avial + thoran + olan + pachadi + erissery + pulissery + papadum + payasam.
  - *Bengali thali*: shukto, czyli mieszane gorzkie warzywa → dal → bhaja, czyli smażone → tarkari → curry rybne / drobiowe → chutney → mishti doi / rasgulla. Ścisła progresja course-by-course - od gorzkiego do słodkiego.

### 5.10 Pan-Asian fusion - zasady i pułapki

- **Zasady**: a) respektuj logikę smakową źródła przed mieszaniem; b) łatwiej pożyczaj techniki między kuchniami, np. japońska precyzja zastosowana do składników wietnamskich, niż mieszaj palety w jednym daniu; c) zakotwicz każde danie w głosie jednej kuchni z jednym komplementarnym akcentem z drugiej; d) bądź transparentny w nazewnictwie.
- **Pułapki**: bezmyślne mieszanie fish sauce + soy + gochujang tworzy mętną "azjatycką" bazę, która spłaszcza różne kultury; mieszanie nabiału z kuchniami tradycyjnie beznabiałowymi, czyli większością Wschodniej / Południowo-Wschodniej Azji, bez intencji; używanie "Asian" jako marketingowego parasola, który wymazuje specyfikę; appropriation bez sourcingu - agent powinien wspierać atrybucję według regionu.
- **Udane przykłady**: David Chang (Momofuku), Roy Choi (Korean-Mexican), Peter Chang, Andy Ricker (Pok Pok - rygorystyczna dokładność północno-tajska jako rodzaj "anti-fusion"), Pim Techamuanvivit.

---

## 6. Psychologia menu i doświadczenie gościa

### 6.1 Logika progresji dań

- **Lekkie → ciężkie** - poziom alkoholu ABV w pairingach rośnie równolegle; gęstość białka wzrasta.
- **Zimne → ciepłe → gorące → ciepłe → zimne** - często; łuk temperatury odzwierciedla łuk energii.
- **Proste → złożone → powściągliwe zamknięcie** - najbardziej technicznie naładowane dania siedzą na pozycjach 4-6 w 8-daniowym menu.
- **Kwas po tłuszczu**; **gorycz przed słodyczą**; **czysty palate cleanser rozdziela dramatyczne pivots smakowe**.

### 6.2 Zapobieganie menu fatigue

- Ogranicz pojedynczą technikę do dwóch niekolejnych dań, np. nie dwa sous-vide-then-seared proteins pod rząd.
- Rotuj dominującą rodzinę aromatyczną z dania na danie. Unikaj trzech kolejnych dań zdominowanych przez alliums, pirazyny albo laktony.
- Zmieniaj wizualną oś talerza: round / oval / rectangular / bowl / coupe.
- Wstawiaj "intermezzi" - palate cleansers, małe sips, pojedyncze bites - co 4-5 dań.

### 6.3 Obsługa ograniczeń dietetycznych

Agent musi produkować **dania równoległe**, nie odejmowanie elementów. Najlepsza praktyka:

- **Vegetarian / Vegan**: buduj dedykowane architektury warzywno-białkowe: stocki grzybowe dla umami; elementy fermentowane dla kokumi; strączki, seitan, plant proteins curingowane koji. Nie usuwaj po prostu białka - to usuwa sens.
- **Gluten-free**: zastąp rice-flour beurre manié, skrobiowymi slurry z kukurydzy, panées z mąk strączkowych, makaronami ryżowymi, purée ziemniaczanym / selerowym jako nośnikami skrobi; weryfikuj soy sauce → tamari, redukcje piwne → redukcje winne, miso → certyfikowane GF.
- **Halal**: bez wieprzowiny, bez redukcji alkoholowych - użyj verjus, octu, redukcji owocowych; mięso z certyfikatem halal.
- **Kosher**: bez wieprzowiny / skorupiaków; rozdzielenie mięso-nabiał w tym samym daniu, a idealnie w całym posiłku; certyfikowane mięsa; świadomość klasyfikacji pareve / dairy / meat.
- **Warstwa alergenów**: opcje nut-free, sesame-free, egg-free, dairy-free, shellfish-free. Każdy output menu powinien mieć matrycę alergenów per danie.
- **Zasada przekrojowa**: projektuj równoległe ścieżki menu, np. chef's tasting + chef's vegetarian tasting + chef's pescatarian tasting, każda wewnętrznie spójna - nie jedno menu z usunięciami.

### 6.4 Narracja sezonowa

Agent powinien umieć artykułować w dwóch zdaniach na menu "historię" - jaki sezon, jakie miejsce, jakie wspomnienie albo koncept. Przykłady: "Późna jesień w Pacific Northwest: menu podąża za powrotem łososia w górę rzeki, od morza (crudo), przez rzekę (wędzony), aż po tarliska (cured roe z leśnymi grzybami)". Albo: "Niedzielny obiad babci w Bolonii, przemyślany na nowo".

### 6.5 Język menu według typu lokalu

- **Bistro**: krótki, ingredient-led, 5-10 słów, np. "Pieczony kurczak, zwęglone pory, sauce gribiche".
- **Casual / mid-range**: opisowy, sensoryczny, np. "Wolno duszone short rib z whipped potato, red-wine jus, crispy shallots" - każdy przymiotnik zwiększa sprzedaż opisywanej pozycji według badań menu engineering, ale inflacja językowa niszczy wiarygodność.
- **Fine dining**: skrajna powściągliwość - 3-5 składników na course, bez przymiotników - ALBO pełna poetycka narracja, np. "Spacer przez las po deszczu" - nigdy środek. Tasting menus często wymieniają tylko hero ingredient: "Marchew"; "Jagnięcina"; "Jabłko", a pełne opisy są dostarczane werbalnie przez serwis.
- **Konwencje nazewnictwa**: francuskie klasyczne nazwy, np. "tournedos Rossini", sygnalizują klasycyzm; nazwy place-based, np. "Provençal", "Niçoise", sygnalizują regionalne zaangażowanie; nazwy od growera / farmy sygnalizują farm-to-table; dania nazwane imieniem chefa sygnalizują autobiografię.

---

## 7. Architektura NotebookLM - rekomendowany podział

NotebookLM działa najlepiej, gdy każdy notatnik zawiera skupiony, spójny korpus, około 20-50 wysokiej jakości źródeł. Mieszanie zbyt wielu domen w jednym notatniku pogarsza retrieval. Rekomendowana architektura to **9 wyspecjalizowanych notatników plus 1 notatnik orkiestracyjny, łącznie 10**, z celową redundancją na źródłach przekrojowych.

### Notebook 1 - Menu Engineering i architektura typu lokalu
*Cel: generuje strukturalny szkielet każdego menu: sekcje, liczbę dań, poziom cenowy, format.*
- Kasavana & Smith, *Menu Engineering* (1982 + aktualizacje)
- Ozdemir & Caliskan, "Menu engineering: a systematic literature review" (*Tourism Management Perspectives*)
- *Menu Design in America* (Heimann / Steele, Taschen) - referencja wizualna
- Przewodniki Toast i TouchBistro dotyczące restaurant menu engineering - benchmarki branżowe
- Archiwum przykładowych menu: 30 reprezentatywnych menu z kategorii bistro / casual / upscale / fine dining / event, w PDF albo transkrypcji
- Dokumenty standardów wielkości porcji cateringowych, kilka źródeł
- Podręczniki plannerów wedding / event / corporate event
- Przykładowe kalendarze sezonowych rotacji z wielu regionów produkcyjnych

### Notebook 2 - Nauka flavor pairing i teoria smaku
*Cel: rekomendacje pairingowe, compound-bridging, regionalne szablony smakowe.*
- Page & Dornenburg, *The Flavor Bible* i *Vegetarian Flavor Bible*
- Page & Dornenburg, *Culinary Artistry*
- Coucquyt, Lahousse & Langenbick, *The Art and Science of Foodpairing*
- Ahn et al., "Flavor network and the principles of food pairing", *Scientific Reports* 1:196 (2011)
- Rachel Herz, *Why You Eat What You Eat* - sensory science
- Charles Spence, *Gastrophysics*
- White papers i profile składników Foodpairing.com
- Research o kokumi: Ohsu et al., Yamamoto, Kuroda, przeglądy z 2024 roku, Oxford *Chemical Senses*
- *On Food and Cooking* - Harold McGee, rozdziały o smaku / aromacie
- McGee, *Nose Dive: A Field Guide to the World's Smells*

### Notebook 3 - Tekstura, struktura i plating
*Cel: mouthfeel, zasady platingu, tekstury modernistyczne.*
- Myhrvold & Bilet, *Modernist Cuisine*, wybrane tomy o teksturze i platingu, oraz *Modernist Cuisine at Home*
- Kamozawa & Talbot, *Ideas in Food*
- Logsdon, *Modernist Cooking Made Easy*
- Adrià, *El Bulli*, wybrane tomy z dekonstrukcją dań
- Achatz, *Alinea* i *The Alinea Project*
- *Plate to Pixel* (Hélène Dujardin) dla wizualnego platingu
- Charles Spence, *Gastrophysics* - badania percepcji platingu
- *Modernist Cuisine: The Art and Science of Cooking* - rozdziały o emulsjach, żelach, pianach, sferyfikacji
- Branżowe przewodniki platingu: Wasserstrom, manuale Culinary Institute of America

### Notebook 4 - Technika klasyczna i kanon francuski
*Cel: sosy, stocki, sosy matka, klasyczne garnish names, brigade.*
- Escoffier, *Le Guide Culinaire* (1903, tłumaczenie angielskie 1907 + późniejsze edycje)
- *The Professional Chef* (Culinary Institute of America)
- *Larousse Gastronomique*
- *Mastering the Art of French Cooking* - Julia Child
- Pépin, *La Technique* i *La Méthode*
- *On Cooking* (Labensky & Hause)
- Madeleine Kamman, *The New Making of a Cook*
- McGee, *On Food and Cooking*, rozdziały techniczne

### Notebook 5 - Techniki modernistyczne i fermentacja
*Cel: sous vide, fermentacja, modernistyczne tekstury, konserwacja.*
- Redzepi & Zilber, *The Noma Guide to Fermentation*
- Redzepi, *Noma: Time and Place in Nordic Cuisine*
- Sandor Katz, *The Art of Fermentation* i *Wild Fermentation*
- Shih & Umansky, *Koji Alchemy*
- Baldwin, *Sous Vide for the Home Cook* i *A Practical Guide to Sous Vide Cooking*
- *Modernist Cuisine* - tomy o fermentacji, sous-vide i preservation
- Polcyn & Ruhlman, *Charcuterie*
- *Curing & Smoking* (Marianski)
- *Salt: A World History* (Kurlansky) jako kontekst

### Notebook 6 - Wiedza regionalna: Włochy, francuskie bistro i Morze Śródziemne
*Cel: jeden spójny notatnik wiedzy o kuchniach zachodnioeuropejskich.*
- Marcella Hazan, *Essentials of Classic Italian Cooking*
- *The Silver Spoon* (Phaidon)
- Samin Nosrat, *Salt Fat Acid Heat*
- Bottura, *Never Trust a Skinny Italian Chef*
- Menu i książki Bertolli / Waters / Chez Panisse
- Yotam Ottolenghi, *Plenty / Jerusalem / Simple* - crossover śródziemnomorski
- Anthony Bourdain, *Les Halles Cookbook*
- Patricia Wells, *Bistro Cooking*

### Notebook 7 - Kuchnie azjatyckie: Chiny, Japonia, Korea, Azja Południowo-Wschodnia, Indie
*Cel: regionalna logika smaku, techniki i struktury Pan-Asian. Duży notatnik; rozważ podział, jeśli przekroczy limity kontekstu.*
- Fuchsia Dunlop, *The Food of Sichuan*, *Land of Plenty*, *Every Grain of Rice*, *Invitation to a Banquet*
- Grace Young, *The Breath of a Wok*, *The Wisdom of the Chinese Kitchen*
- Shizuo Tsuji, *Japanese Cooking: A Simple Art*
- Elizabeth Andoh, *Washoku: Recipes from the Japanese Home Kitchen*
- Nancy Singleton Hachisu, *Japan: The Cookbook*
- David Thompson, *Thai Food* i *Thai Street Food*
- Andy Ricker, *Pok Pok*
- Pim Techamuanvivit, *The Foods of Northern Thailand*
- Charles Phan, *Vietnamese Home Cooking*
- Madhur Jaffrey, *An Invitation to Indian Cooking* i *Madhur Jaffrey's Indian Cookery*
- Maunika Gowardhan, *Indian Kitchen*
- Cheong Liew / Tetsuya Wakuda jako przykłady fusion

### Notebook 8 - Ameryki i Bliski Wschód / Afryka Północna
*Cel: kuchnia meksykańska, latynoamerykańska, bliskowschodnia, północnoafrykańska, nowoczesna nordycka.*
- Diana Kennedy, *The Cuisines of Mexico* i *Oaxaca al Gusto*
- Enrique Olvera, *Mexico from the Inside Out* i *Tu Casa Mi Casa*
- Rick Bayless, *Authentic Mexican* i *Mexico: One Plate at a Time*
- Gabriela Cámara, *My Mexico City Kitchen*
- Yotam Ottolenghi & Sami Tamimi, *Jerusalem* i *Falastin* (Sami Tamimi & Tara Wigley)
- Reem Kassis, *The Palestinian Table*
- Claudia Roden, *The Book of Jewish Food* i *The New Book of Middle Eastern Food*
- Paula Wolfert, *The Food of Morocco*
- Najmieh Batmanglij, *Food of Life* - perska
- Marcus Samuelsson, *The Rise* - diaspora afrykańska
- Magnus Nilsson, *The Nordic Cookbook*
- Redzepi, *A Work in Progress*

### Notebook 9 - Psychologia menu, doświadczenie gościa i architektura serwisu
*Cel: behavioral, accommodation, narrative i service design.*
- Brian Wansink, *Mindless Eating* - badania psychologii jedzenia
- Charles Spence, *Gastrophysics*
- Wybrane prace Daniela Levitina / Daniela Kahnemana o choice architecture, istotne dla obciążenia wyborem w menu
- Teksty AHLEI / CIA o service management
- Toast i Cornell Hospitality - badania o menu psychology
- Profesjonalne dokumenty o alergenach i ograniczeniach dietetycznych: FARE, Coeliac UK, publikacje organów certyfikujących halal / kosher
- Przykładowe narracje tasting menu - 10-15 z restauracji gwiazdkowych Michelin
- Case studies designu menu: Alinea / Eleven Madison Park / The French Laundry

### Notebook 10 - Notatnik orkiestracyjny / master notebook
*Cel: notatnik, który agent zawsze ładuje. Zawiera przekrojowe dane referencyjne i indeks routingu mówiący agentowi, który inny notatnik ma odpytać przy danym zadaniu.*
- Master calendar sezonowości składników dla wielu regionów klimatycznych
- Master matrix alergenów i diet, każdy składnik oznaczony
- Master tables temperatur gotowania
- Master cost / yield tables dla protein primals
- Master conversion tables: metric, imperial, baker's percentage
- Style guide języka menu według typu lokalu
- *Router document* - 5-10 stron indeksu mapującego typy zadań, np. "zaprojektuj 12-daniowe tasting menu", "zbuduj halal corporate buffet dla 200 osób", "zrotuj jesienne menu bistro", do optymalnej kombinacji notatników do odpytania.

### Dlaczego taka architektura

- **9 wyspecjalizowanych + 1 master** utrzymuje każdy notatnik poniżej efektywnego limitu 50 źródeł, zapobiegając context pollution.
- **Nakładanie się źródeł jest celowe**: McGee, *Modernist Cuisine* i *The Flavor Bible* pojawiają się w 2-3 notatnikach, bo są uniwersalnie użyteczne - każdy notatnik dostaje tylko właściwe rozdziały, nie całe dzieło.
- **Notatniki regionalne są podzielone na East / West / Asia**, ponieważ logika pairingu rzeczywiście się różni, według Ahn 2011 - połączenie ich w jedno daje uśrednianie, nie syntezę.
- **Notatnik orkiestracyjny jest jedynym zawsze ładowanym**; inne notatniki są odpytywane on-demand. To odzwierciedla architekturę używaną przez retrieval-augmented agents w OpenAI i Anthropic dla systemów eksperckich domenowo.
- **Dla bardzo dużych operacji** notatnik azjatycki (#7) można podzielić na 7a East Asia, 7b Southeast Asia, 7c South Asia / India - łącznie 12 notatników. Dla mniejszych wdrożeń produkcyjnych notatniki 6 i 8 można połączyć w jeden "Western / Mediterranean / MENA" - łącznie 8 notatników.

---

## Zastrzeżenia, konflikty i uwagi o jakości źródeł

- **Sosy matka - pięć kontra sześć**: oryginalny francuski *Guide Culinaire* Escoffiera wymieniał Hollandaise jako "petite sauce", a nie "grande". Znana dziś "piątka sosów matka" pochodzi z angielskiego tłumaczenia z 1907 roku. Niektóre współczesne opracowania francuskie, na przykład Alex z *FrenchGuyCooking*, argumentują, że majonez jest bardziej zasadnym sosem matka niż hollandaise. Agent powinien traktować kanoniczną piątkę: béchamel, velouté, espagnole, tomate, hollandaise, jako roboczy konsensus, ale znać komplikację historyczną.
- **Hipoteza Foodpairing jest sporna dla kuchni niezachodnich**: Ahn et al. (2011) to główny recenzowany kontrapunkt pokazujący, że kuchnie wschodnioazjatyckie celowo unikają współdzielenia związków aromatycznych. Agent nie powinien stosować logiki shared-aroma w stylu Foodpairing równomiernie - powinien flagować kontekst kuchni.
- **Kokumi jako "szósty smak"** zyskuje akceptację, ale nie jest jeszcze powszechnie skodyfikowane tak jak umami. Bezpieczniejsze naukowo ujęcie to traktowanie kokumi jako *modulatora*, a nie samodzielnego smaku.
- **Temperatury wewnętrzne gotowania**: chef's targets, np. wieprzowina w 63°C, pierś z kurczaka zdejmowana przy 60°C w sous-vide, różnią się od konserwatywnych celów USDA. Agent musi wyjaśniać, który standard rekomenduje, i respektować obowiązki bezpieczeństwa żywności w środowisku komercyjnym.
- **Jakość źródeł**: blogi branżowe, na przykład blogi restaurant POS i przewodniki firm cateringowych, są przydatne jako benchmarki, ale nie są autorytatywne dla techniki - w sprawach krytycznych dla bezpieczeństwa należy dawać pierwszeństwo Escoffierowi, McGee, *The Professional Chef* i recenzowanym źródłom z food science.
- **Wytyczne porcji canapé** różnią się znacząco regionalnie: UK kontra US kontra Australia / NZ; liczby w §1.6 są syntezą - przy menu produkcyjnym agent powinien domyślnie lekko nadkaterować i zweryfikować z venue.

Ten pakiet researchowy, zakodowany w proponowanej architekturze 9-10 notatników, powinien dać produkcyjnemu agentowi AI do tworzenia menu głębię potrzebną do pracy na poziomie doświadczonego Head Chefa - od wtorkowego lunchu w bistro po 14-daniowe tasting menu weselne - z jawną świadomością tradycji, techniki, nauki i psychologii stojących za każdą decyzją, którą generuje.
