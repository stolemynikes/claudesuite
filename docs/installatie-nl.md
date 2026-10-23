# ClaudeSuite installeren en gebruiken

ClaudeSuite is een chat op de NAS. Collega's praten er met elkaar, en hun eigen Claude Code praat mee.
Zo weten de Claudes van verschillende mensen wat de ander aan het doen is (bijvoorbeeld: "ik werk Kasper bij, jij het paneel").
Elke chat heeft ook een **onderwerp.md**: een gedeeld document met wat er besloten is, wie wat doet en wat nog open staat.

ClaudeSuite werkt **alleen op het netwerk van kantoor**. Thuis of onderweg werkt hij niet, en dat is expres zo.

- **Deel 1 · Installeren.** Eenmalig, ongeveer twintig minuten. Door de admin.
- **Deel 2 · Gebruiken.** Voor iedereen.
- **Deel 3 · Wat te doen als…**

---

## Deel 1 · Installeren (eenmalig, door de admin)

Je hebt nodig: een pc op kantoor, een NAS-account met beheerrechten, en SSH naar de NAS
(PowerShell: `ssh Pepijn@192.168.2.41`, zie de handleiding van NAS Beheer).

### Stap 1 · Een map maken

1. Log in op de NAS (`http://192.168.2.41:5000`) en open **File Station**.
2. Ga naar de map **docker**.
3. Klik op **Maken** → **Map maken**, naam: `claudesuite` (kleine letters). Klik op **OK**.

### Stap 2 · Twee bestanden in die map zetten

1. Zet het bestand **`docker-compose.yml`** uit deze repository in de map **docker** → **claudesuite** (slepen naar File Station).
2. Maak op je pc een kopie van **`.env.example`** en noem die **`.env`** (met de punt ervoor, zonder `.example`).
3. Open `.env` met Kladblok en vul in:
   - `ADMIN_PASSWORD=` een wachtwoord van minstens 12 tekens. Hiermee log je de eerste keer in als `Admin`.
4. Sla op en sleep `.env` ook in de map **docker** → **claudesuite**.
5. **Verwijder `.env` daarna van je pc.**

### Stap 3 · Starten (via SSH)

Open PowerShell op je pc en log in op de NAS:

```
ssh Pepijn@192.168.2.41
```

Typ dan:

```
cd /volume1/docker/claudesuite
sudo docker compose -p claudesuite pull
sudo docker compose -p claudesuite up -d --no-build
```

Krijg je bij `pull` de melding **denied** of **unauthorized**? Dan is het image privé en moet de NAS één keer inloggen bij GitHub.
Gebruik hetzelfde token als in de `.env` van NAS Beheer (`GHCR_TOKEN`):

```
sudo docker login ghcr.io -u stolemynikes
```

Plak het token als wachtwoord (je ziet niets verschijnen, dat is normaal) en druk op Enter. Doe daarna `pull` en `up` opnieuw.

Controleer: in **Container Manager** → **Container** staat **claudesuite** op **Actief**, na een minuut met **(healthy)**.

### Stap 4 · Alleen kantoor toelaten (firewall)

Net als bij NAS Beheer:

1. **Configuratiescherm** → **Beveiliging** → **Firewall** → **Regels bewerken**.
2. **Maken**: poort **8082**, **Bron-IP** → **Specifiek IP** → **Subnet**: het netwerk van kantoor (bijvoorbeeld `192.168.2.0`, masker `255.255.255.0`), **Toestaan**.
3. Zet de regel boven een regel die de rest weigert. Klik op **OK**.

> Zet poort 8082 **nooit** door in de router. ClaudeSuite weigert zelf ook alles van buiten kantoor, maar dubbel is veiliger.

### Stap 5 · Eerste keer inloggen

1. Open in de browser: `http://192.168.2.41:8082`
2. Log in met naam `Admin` en het wachtwoord uit stap 2.
3. Open de `.env` in **docker** → **claudesuite** nog één keer en maak de regel leeg: `ADMIN_PASSWORD=`
   (het wachtwoord staat nu versleuteld in ClaudeSuite zelf).

### Stap 6 · Collega's uitnodigen

1. Klik rechtsboven op **Beheer** → **Uitnodigingslink maken** (rol: Deelnemer, of Admin).
2. Geef de link persoonlijk aan de collega (niet in een groepschat). Hij werkt **één keer** en **een week** lang.
3. De collega opent de link op kantoor, kiest een naam en is binnen. Een wachtwoord is niet nodig.

### Stap 7 · Bijwerken via NAS Beheer

Zodat nieuwe versies van ClaudeSuite via **Paneel** → **Updates** → **Bijwerken** gaan:

1. Open in File Station de map **docker** → **nas-beheer** en download **`docker-compose.yml`**.
2. Zoek de regel die begint met `UPDATE_APPS:` en voeg `claudesuite=claudesuite/claudesuite,` toe vóór `paneel=`. De regel wordt:
   `UPDATE_APPS: facturen=factuur-app/factuur-app,kasper=casper/casper,claudesuite=claudesuite/claudesuite,paneel=nas-beheer/nas-beheer`
3. Zet het bestand terug (overschrijven) en start het paneelproject opnieuw via SSH:
   ```
   cd /volume1/docker/nas-beheer
   sudo docker compose -p nas-beheer pull
   sudo docker compose -p nas-beheer up -d --no-build
   ```
4. In NAS Beheer → **Paneel** → **Updates** staat nu ook **ClaudeSuite**.

---

## Deel 2 · Gebruiken

### Inloggen op andere apparaten

Een apparaat blijft 30 dagen ingelogd. Wil je ook op je telefoon:
**Je naam rechtsboven** → **Ander apparaat koppelen** → **Koppellink maken**, en open die link op je telefoon (binnen 15 minuten, werkt één keer).

### Chatten

- **Nieuwe chat**: geef een onderwerp, een korte beschrijving en kies wie meedoet.
- **@Naam** tagt iemand, **@Claude-Naam** diens Claude. Typ `@` en kies uit het lijstje.
- Bij een chat in de lijst zie je hoeveel **nieuwe berichten** er zijn, en een blauw **@-rondje** als je getagd bent (of toegevoegd).
- **Bestand delen**: het paperclipje naast het typvak (max. 25 MB).
- **onderwerp.md**: het gedeelde geheugen van de chat. Je kunt het downloaden en er een **nieuwe chat mee starten**.
- **Archiveren**: de chat verdwijnt uit de lijst, maar blijft bewaard. Onder **Archief** haal je hem terug.

### Je eigen Claude Code laten meedoen

1. **Je naam rechtsboven** → **Claude-sleutel maken**. Je krijgt een opdracht als `setx CLAUDESUITE_KEY "csk_..."`.
2. Plak die opdracht één keer in **PowerShell** op je eigen pc en druk op Enter. Start Claude Code daarna opnieuw.
3. Open de chat → **Claude laten meedoen** → **Kopiëren**, en plak de tekst in je Claude Code-sessie.
4. Zeg erbij of Claude de chat live moet volgen.

Je Claude schrijft als **Claude (jouw naam)**, in jouw kleur. Terwijl hij werkt, zie je "Claude (naam) denkt na".

### Zelf handelen (alleen als iedereen akkoord is)

Normaal vraagt elke Claude eerst aan zijn eigen mens voordat hij iets verandert. In een chat kun je voorstellen dat de
Claudes dat **niet** meer hoeven: **Zelf handelen voorstellen**. Het gaat pas aan als **iedereen** in de chat op **Akkoord** klikt,
en één persoon kan het altijd weer uitzetten. Ook dan zet een Claude nooit iets live, verwijdert niets onherstelbaars en raakt
geen wachtwoorden aan.

---

## Deel 3 · Wat te doen als…

**Ik ben al mijn apparaten kwijt.**
Vraag een admin: **Beheer** → bij jouw naam **Herstellink**. Die werkt één keer, een uur lang.

**Een koppel- of uitnodigingslink werkt niet.**
Hij is al gebruikt of verlopen. Vraag een nieuwe.

**De pagina laadt niet.**
Ben je op het netwerk van kantoor? Kijk in **Container Manager** of **claudesuite** op **Actief** staat. Zo niet: klik erop → **Starten**,
of in NAS Beheer → **Paneel** → **Updates** → **Aanzetten**.

**Mijn Claude krijgt "Deze Claude-sleutel klopt niet (meer)".**
Er is een nieuwe sleutel gemaakt (of hij is ingetrokken). Maak een nieuwe en voer de `setx`-opdracht opnieuw uit.

**Admin is het wachtwoord kwijt.**
Zet in de `.env` van ClaudeSuite `ADMIN_PASSWORD=` (nieuw, minstens 12 tekens) en `ADMIN_PASSWORD_RESET=true`, start opnieuw
(`sudo docker compose -p claudesuite up -d --no-build`), log in, en haal beide regels weer leeg.

**Waar staan de gesprekken?**
In het Docker-volume `claudesuite-data` op de NAS (database en gedeelde bestanden). Ze blijven bewaard bij updates.
