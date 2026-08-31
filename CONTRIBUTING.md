# Kehityskäytännöt

Tämä tiedosto kuvaa, miten Manifestivalia kehitetään turvallisesti ja
palautettavasti. Käytäntö otettiin käyttöön WP1:ssä.

---

## Lähtötilanne, jonka tämä korjaa

Ennen WP1:tä kaikki muutokset tehtiin **suoraan GitHubin selaineditorissa
`main`-haaraan**, josta ne menivät välittömästi tuotantoon. Repossa on 11
committia, joiden viestit ovat "Update index.html". Katselmointia ei ollut,
testejä ei ollut, eikä rollbackille ollut käytäntöä.

---

## Perussäännöt

1. **`main` ei ole kehityshaara.** Se on tuotanto. Siihen ei pushata suoraan
   eikä siinä editoida GitHubin selaineditorissa.
2. **Kehitys tapahtuu paikallisessa kloonissa**, ei selaimessa.
3. **Yksi työpaketti = yksi feature-haara.**
4. **Testit ajetaan ennen mergeä.** `npm test` ja `npm run check` täytyy mennä läpi.
5. **Salaisuudet eivät koskaan mene versionhallintaan.** Ks. `docs/SECURITY.md`.
6. **Tuotantoon vievä merge on aina tietoinen päätös**, ei sivuvaikutus.

---

## Haaramalli

```
main                    tuotanto — suojattu, vain katselmoitu koodi
 └── develop            integraatiohaara
      └── feature/wp-N-lyhyt-kuvaus     yksi työpaketti
```

Haaran nimeäminen:

```
feature/wp-1-foundation-security
feature/wp-2-task-model
fix/timeline-now-state
```

---

## Työnkulku

```
1. Suunnittelu           työpaketin scope ja hyväksymiskriteerit sovitaan
2. Haara                 git checkout develop && git checkout -b feature/wp-N-...
3. Toteutus              muutokset paikallisessa kloonissa
4. Testit                npm test && npm run check
5. Katselmointi          git diff develop...HEAD käydään läpi
6. Merge -> develop      integraatio, testit uudelleen
7. Merge -> main         tuotantojulkaisu, tietoinen päätös
8. Vercel                deployaa main-haarasta automaattisesti
```

---

## Ennen jokaista mergeä

- [ ] `npm test` menee läpi
- [ ] `npm run check` menee läpi
- [ ] `git diff` on luettu läpi ja rajautuu tähän työpakettiin
- [ ] Yhtään salaisuutta ei ole lisätty (`git diff | grep -i "key\|secret\|token"`)
- [ ] Tietokantamuutokset ovat migraationa `supabase/migrations/`-hakemistossa
- [ ] Migraatio on ajettu ja todennettu ennen kuin siitä riippuva koodi menee `main`iin
- [ ] Dokumentaatio on päivitetty, jos arkkitehtuuri tai skeema muuttui

---

## Tietokantamuutokset

Tietokanta on jaettu resurssi, eikä sitä voi peruuttaa haaranvaihdolla.

- Jokainen skeemamuutos kirjoitetaan numeroituna SQL-migraationa
  `supabase/migrations/`-hakemistoon.
- Migraatiota **ei ajeta tuotantoon** ennen kuin se on katselmoitu ja
  varmuuskopio on otettu.
- Käsin tehtyjä, dokumentoimattomia muutoksia Supabase-dashboardissa ei tehdä.
  Jos jotain on pakko tehdä käsin, se kirjoitetaan jälkikäteen migraatioksi.
- Migraation ja siitä riippuvan koodin julkaisujärjestys sovitaan etukäteen.

---

## Testaus

Desktop-testit riittävät normaalissa kehityksessä. Fyysistä puhelinta ei
käytetä kehityssilmukassa — vain erikseen sovittuina hyväksymistesteinä
silloin, kun kyse on natiiviominaisuuksista (ilmoitukset, sijainti, taustatila).

Testit eivät saa kirjoittaa tuotantotietokantaan. Nykyiset testit ovat puhtaita
yksikkö- ja staattisia testejä eivätkä ota verkkoyhteyttä.

---

## Commit-viestit

Kuvaa **mitä muuttui ja miksi**, älä "Update index.html".

```
feat(auth): lisää Supabase Auth ja käyttäjäkohtainen datan eristys
fix(timeline): NYT-tila jäi jumiin automaattiseen herätysmerkintään
docs: kuvaa RLS-malli ja migraation ajojärjestys
chore(test): lisää staattiset turvallisuusinvariantit
```
