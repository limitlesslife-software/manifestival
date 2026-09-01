# Mega-aalto WP7–WP12 — suunnitelma

Haara: `feature/wp-7-12-mega-product`
Lähtö-HEAD: `6447fa96c70c8359678aa2a95b21029da7f65227`
Baseline: 307/307 testiä, check PASS, smoke PASS.

---

## Lähtötilanne

WP1–WP6 rakensi perustan. Tämä aalto rakentaa **tuotteen** sen päälle.

| Alue | Tila ennen tätä aaltoa |
|---|---|
| Tehtävät | Toimii: luonti, muokkaus, poisto, valmistuminen, prioriteetti, kesto |
| Aikataulumoottori | Puhdas funktio, 39 testiä. Herätys, uni, vapaat välit, ehdotukset |
| Rutiinit | **Yksi kovakoodattu aamurutiini.** Ei domainia, ei toistosääntöjä |
| Tavoitteet | **Ei mitään** |
| Projektit | **Ei mitään** |
| Määräajat | **Ei mitään** — vain `date` (aikataulutus) |
| Ilmoitukset | **Ei mitään** — vain lupasovitin |
| AI | Yksi intentti: luo tehtävä |
| Hyvinvointi | **Ei mitään** |
| Talous | **Ei mitään** — vain kategoria |

Manifestival on tällä hetkellä **erinomainen päiväsuunnittelija**. Se ei ole
vielä elämänhallintajärjestelmä, koska tavoitteet, rutiinit ja muistutukset
puuttuvat — ne kolme yhdistävät päivän pidempään aikaväliin.

---

## Tämän aallon tavoite

Yksi lause: **päivä lakkaa olemasta irrallinen.**

```
TAVOITE ──── PROJEKTI ──── TEHTÄVÄ ──── PÄIVÄ ──── MUISTUTUS
   │                          │            │
   └── edistyminen            │            └── RUTIINI (toistuu)
                              └── MÄÄRÄAIKA (kiireellisyys)
```

Konseptidokumentin luku 7 kuvaa tämän ketjuna:
*tavoite → suunnitelma → kalenteriin varattu aika → muistutus ja ohjaus →
toteutus → seuranta → oppiminen → parempi seuraava suunnitelma.*

Tämän aallon jälkeen ketju on olemassa kokonaisuudessaan, vaikka osa
lenkeistä on vielä kevyitä.

---

## Työjärjestys ja riippuvuudet

```
1. WP7  Rutiinit          ──┐
2. WP8  Tavoitteet        ──┤
3. WP9  Projektit + määräajat ─┼──> 4. Scheduler V3
                              │        (tarvitsee kaikki kolme)
5. WP10 Ilmoitukset       <───┘
6. WP11 AI-komennot       (tarvitsee 1–3: mitä komennot voivat luoda)
7. Päivä/viikko V2        (näyttää kaiken yllä olevan)
8. Katsaukset             (koostaa 1–3:sta)
9. Hyvinvointi            (signaali schedulerille, ei pakota)
10. Talous/sijoitukset    (vain arkkitehtuuri)
```

Rutiinit ensin, koska scheduler tarvitsee ne. Tavoitteet ja projektit
seuraavaksi, koska tehtävä viittaa niihin. Scheduler V3 vasta kun kaikki
signaalit ovat olemassa.

---

## Arkkitehtuuriperiaatteet tässä aallossa

Nämä eivät ole uusia — ne ovat WP2:n periaatteet, joita ei rikota.

1. **Domain pysyy puhtaana.** Ei DOM:ia, ei verkkoa, ei kelloa. Nykyhetki
   annetaan parametrina. Tämä on testattu invariantti.
2. **Riippuvuudet alaspäin.** Uudet moduulit noudattavat samaa kerrosjakoa.
   `platform/` ei saa vuotaa domainiin.
3. **Käyttäjän päätös voittaa automaatin.** Rutiini ei siirrä käyttäjän
   ajastamaa tehtävää. Hyvinvointi ei muuta suunnitelmaa itsestään. AI ei
   suorita mitään ilman vahvistusta.
4. **Determinismi.** Sama syöte, sama tulos. Rutiinien laajennus ja
   aikataulutus ovat molemmat testattavissa ilman satunnaisuutta.
5. **Skeemaportti.** Kaikki uusi, joka vaatisi tietokantaa, rakennetaan
   domainiin ja käyttöliittymään, mutta persistenssi jää portin taakse.
   Käyttöliittymä **kertoo rehellisesti**, mikä ei vielä säily.

---

## Skeemaportti tässä aallossa

Production-Supabase on pausella eikä `inventory.sql` ole ajettu. Siksi:

| Alue | Toteutus | Persistenssi |
|---|---|---|
| Rutiinit | IMPLEMENTED | REQUIRES MIGRATION 0003 |
| Rutiinipoikkeukset | IMPLEMENTED | REQUIRES MIGRATION 0003 |
| Tavoitteet | IMPLEMENTED | REQUIRES MIGRATION 0004 |
| Projektit | IMPLEMENTED | REQUIRES MIGRATION 0004 |
| Tehtävän määräaika ja linkit | IMPLEMENTED | REQUIRES MIGRATION 0004 |
| Ilmoitusasetukset | IMPLEMENTED | REQUIRES MIGRATION 0005 |
| Hyvinvointimerkinnät | IMPLEMENTED | REQUIRES MIGRATION 0006 |
| Talous | PLANNED (vain domain-luonnos) | — |
| Sijoitukset | PLANNED (vain dokumentti) | — |

**Yksikään migraatio ei ajeta tässä aallossa.**

Jotta koko uusi domain on testattavissa ilman verkkoa, rakennetaan
in-memory-repositorio testejä varten. Se **ei ole tuotannon datakerros**.

---

## Mitä EI tehdä tässä aallossa

- Ei pankki- eikä markkinadata-integraatiota
- Ei oikeita push-ilmoituksia tuotantoon
- Ei AI-yhteenvetoa pakolliseksi katsauksiin
- Ei offline-kirjoitusjonoa (vaatii konfliktimallin, oma pakettinsa)
- Ei many-to-many-mallia tehtävän ja tavoitteen välille — yksi tavoite riittää
- Ei raskasta kalenterikirjastoa; oma toteutus riittää
- Ei tuotanto-allekirjoitusavainta

---

## Production-gatet

| Gate | Mitä estää | Kuka avaa |
|---|---|---|
| Supabase pausella | Kaikki persistenssi | Käyttäjä: resume + `inventory.sql` |
| Migraatiot 0001–0006 ajamatta | Uusien moduulien tallennus | Käyttäjä, `docs/PRODUCTION-ACTIVATION.md` |
| Anthropic-avain kiertämättä | Turvallinen tuotantojulkaisu | Käyttäjä |
| Allekirjoitusavain puuttuu | Play Store -julkaisu | Käyttäjä |
| Laitetestaus | APK:n hyväksyntä | Käyttäjä |

---

## Mittarit

| | Ennen | Tavoite |
|---|---|---|
| Testit | 307 | 450+ merkityksellistä |
| Domain-moduulit | 5 | ~12 |
| Näkymät | 4 | 6 |
| MVP-valmius | ~45 % | selvästi korkeampi |
