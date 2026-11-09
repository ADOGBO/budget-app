// ============================================================================
// perso.js : la page "Perso"
//   - enveloppes : chaque salaire reçu est réparti dans des enveloppes
//   - dépenses perso : chaque dépense puise dans une enveloppe
//   - transferts entre enveloppes
//
// Ce fichier est chargé par index.html. Toutes les données sont rangées sous
//   utilisateurs/<identifiant de l'utilisateur>/...
// afin de pouvoir, plus tard, les protéger par des règles de sécurité sans rien migrer.
//
// Solde d'une enveloppe =
//   (parts de salaire reçues) + (transferts reçus) - (transferts envoyés) - (dépenses)
// ============================================================================

export function initPerso(ctx) {
  // Les outils nous sont passés par index.html
  const { db, collection, doc, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy } = ctx.firebase;
  const { formatEuro, formatDate, dateDuJour } = ctx.outils;
  const racine = ctx.conteneur;    // la zone de la page où l'on construit l'interface

  // Enveloppes proposées tant que rien n'est enregistré
  const ENVELOPPES_PAR_DEFAUT = [
    { id: "courant", nom: "Dépenses courantes", type: "fixe", valeur: 0, parDefaut: true, archivee: false },
    { id: "epargne", nom: "Épargne", type: "fixe", valeur: 0, parDefaut: false, archivee: false }
  ];

  // ==========================================================================
  // 1) ÉTAT : les données reçues de Firebase
  // ==========================================================================
  let uid = null;                        // identifiant de l'utilisateur connecté
  let enveloppes = ENVELOPPES_PAR_DEFAUT;
  let revenus = [];                      // salaires reçus
  let depenses = [];                     // dépenses perso
  let transferts = [];
  let arrets = [];                       // fonctions pour arrêter l'écoute en temps réel
  let depenseEnEdition = null;           // id de la dépense en cours de modification
  let periodeListe = null;               // début de la période choisie pour la liste (null = en cours)
  let signatureRepartition = "";         // pour ne reconstruire la répartition que si les enveloppes changent
  let champsRepartition = {};            // id d'enveloppe -> champ de saisie du montant
  const ui = {};                         // les éléments de la page, rangés ici

  // ==========================================================================
  // 2) OUTILS
  // ==========================================================================

  // Arrondi au centime (évite les erreurs du genre 0.1 + 0.2 = 0.30000000000000004)
  function arrondi(x) {
    return Math.round(x * 100) / 100;
  }

  // Fabrique un élément HTML :
  //   el("button", { texte: "OK", classe: "petit", onclick: fonction }, enfant1, enfant2...)
  function el(balise, attributs, ...enfants) {
    const element = document.createElement(balise);
    for (const cle in (attributs || {})) {
      const valeur = attributs[cle];
      if (cle === "texte") element.textContent = valeur;
      else if (cle === "classe") element.className = valeur;
      else if (cle.startsWith("on")) element.addEventListener(cle.slice(2), valeur);   // onclick -> "click"
      else element.setAttribute(cle, valeur);
    }
    for (const enfant of enfants) {
      if (enfant) element.appendChild(enfant);
    }
    return element;
  }

  // Un paragraphe "Aucune ..." quand il n'y a rien à montrer
  function vide(conteneur, texte) {
    conteneur.appendChild(el("p", { classe: "vide", texte: texte }));
  }

  // Un bloc repliable (comme "Seuils", "Catégories"...)
  function repliable(titre) {
    const contenu = el("div", { classe: "contenu-details" });
    const details = el("details", null, el("summary", { texte: titre }), contenu);
    return { details: details, contenu: contenu };
  }

  // Ajoute une étiquette puis son champ dans un formulaire
  function ligneChamp(parent, id, texteLabel, champ) {
    champ.id = id;
    parent.appendChild(el("label", { for: id, texte: texteLabel }));
    parent.appendChild(champ);
  }

  // Chemin d'une donnée de l'utilisateur : ["utilisateurs", uid, ...]
  function chemin(...segments) {
    return ["utilisateurs", uid].concat(segments);
  }
  function refEnveloppes() { return doc(db, ...chemin("reglages", "enveloppes")); }
  function refCollection(nom) { return collection(db, ...chemin(nom)); }
  function refDocument(nom, id) { return doc(db, ...chemin(nom, id)); }

  // Transforme un résultat Firebase en liste d'objets { id, ...champs }
  function lire(snapshot) {
    const liste = [];
    snapshot.forEach(function (ligneDoc) {
      liste.push({ id: ligneDoc.id, ...ligneDoc.data() });
    });
    return liste;
  }

  function erreur(e) {
    alert("Erreur : " + e.message);
  }

  // ---- Enveloppes ----
  function actives() {
    return enveloppes.filter(function (e) { return !e.archivee; });
  }
  function enveloppeParDefaut() {
    return actives().find(function (e) { return e.parDefaut; }) || actives()[0];
  }
  function nomEnveloppe(id) {
    const e = enveloppes.find(function (x) { return x.id === id; });
    return e ? e.nom : id;
  }
  function texteRegle(e) {
    if (e.parDefaut) return "reçoit le reste du salaire";
    if (e.type === "pourcent") return String(e.valeur).replace(".", ",") + " % du salaire";
    return formatEuro(e.valeur) + " par salaire";
  }
  function enregistrerEnveloppes(liste) {
    setDoc(refEnveloppes(), { liste: liste }).catch(erreur);
  }

  // Solde de chaque enveloppe : { idEnveloppe: solde }
  function soldes() {
    const s = {};
    for (const e of enveloppes) s[e.id] = 0;
    function ajouter(id, montant) { s[id] = (s[id] || 0) + montant; }

    for (const r of revenus) {
      for (const id in (r.repartition || {})) ajouter(id, r.repartition[id]);   // parts de salaire
    }
    for (const t of transferts) {
      ajouter(t.vers, t.montant);       // l'enveloppe qui reçoit
      ajouter(t.de, -t.montant);        // l'enveloppe qui envoie
    }
    for (const d of depenses) ajouter(d.envId, -d.montant);                      // dépenses

    for (const id in s) s[id] = arrondi(s[id]);
    return s;
  }

  // Répartition proposée pour un salaire, d'après les règles des enveloppes :
  // chaque enveloppe prend sa part (montant fixe ou pourcentage), le reste va à l'enveloppe par défaut.
  function propositionRepartition(montant) {
    const repartition = {};
    let somme = 0;
    for (const e of actives()) {
      if (e.parDefaut) continue;
      const part = arrondi(e.type === "pourcent" ? (montant * e.valeur) / 100 : e.valeur);
      repartition[e.id] = part;
      somme += part;
    }
    const defaut = enveloppeParDefaut();
    if (defaut) repartition[defaut.id] = arrondi(montant - somme);
    return repartition;
  }

  // ==========================================================================
  // 3) CONSTRUCTION DE L'INTERFACE (une seule fois)
  // ==========================================================================
  function construireInterface() {
    racine.innerHTML = "";

    // ---- Aperçu des enveloppes ----
    ui.apercu = el("div");
    racine.appendChild(el("section", { classe: "carte" }, el("h2", { texte: "Mes enveloppes" }), ui.apercu));

    // ---- Nouvelle dépense perso ----
    ui.formDepense = el("form");
    ui.dDate = el("input", { type: "date" });
    ui.dMontant = el("input", { type: "number", step: "0.01", min: "0", inputmode: "decimal" });
    ui.dEnv = el("select");
    ui.dCat = el("input", { type: "text", list: "perso-categories", autocomplete: "off" });
    ui.listeCat = el("datalist", { id: "perso-categories" });
    ui.dNote = el("input", { type: "text" });
    ui.dValider = el("button", { type: "submit", texte: "Ajouter la dépense" });
    ui.dAnnuler = el("button", { type: "button", classe: "secondaire", texte: "Annuler la modification", hidden: "" });
    ligneChamp(ui.formDepense, "perso-d-env", "Enveloppe", ui.dEnv);
    ligneChamp(ui.formDepense, "perso-d-montant", "Montant (€)", ui.dMontant);
    ligneChamp(ui.formDepense, "perso-d-date", "Date", ui.dDate);
    ligneChamp(ui.formDepense, "perso-d-cat", "Catégorie (facultatif)", ui.dCat);
    ui.formDepense.appendChild(ui.listeCat);
    ligneChamp(ui.formDepense, "perso-d-note", "Note (facultatif)", ui.dNote);
    ui.formDepense.appendChild(ui.dValider);
    ui.formDepense.appendChild(ui.dAnnuler);
    ui.dDate.value = dateDuJour();
    racine.appendChild(el("section", { classe: "carte" }, el("h2", { texte: "Nouvelle dépense perso" }), ui.formDepense));

    // ---- Liste des dépenses perso d'une période ----
    ui.pSelect = el("select", { id: "perso-periode" });
    ui.pTotal = el("p", { classe: "note" });
    ui.liste = el("ul");
    racine.appendChild(el("section", { classe: "carte" },
      el("h2", { texte: "Dépenses perso" }),
      el("label", { for: "perso-periode", texte: "Période" }),
      ui.pSelect, ui.pTotal, ui.liste));

    // ---- Salaire reçu ----
    const salaire = repliable("💶 Enregistrer un salaire");
    ui.formSalaire = el("form");
    ui.sDate = el("input", { type: "date" });
    ui.sMontant = el("input", { type: "number", step: "0.01", min: "0", inputmode: "decimal" });
    ui.sLibelle = el("input", { type: "text" });
    ui.repartition = el("div");
    ui.sMessage = el("p", { classe: "note" });
    ligneChamp(ui.formSalaire, "perso-s-date", "Date de réception", ui.sDate);
    ligneChamp(ui.formSalaire, "perso-s-montant", "Montant reçu (€)", ui.sMontant);
    ligneChamp(ui.formSalaire, "perso-s-libelle", "Libellé (facultatif)", ui.sLibelle);
    ui.formSalaire.appendChild(el("p", { classe: "note", texte: "Répartition proposée selon les règles de tes enveloppes (tu peux l'ajuster) :" }));
    ui.formSalaire.appendChild(ui.repartition);
    ui.formSalaire.appendChild(ui.sMessage);
    ui.formSalaire.appendChild(el("button", { type: "submit", texte: "Valider la répartition" }));
    ui.listeRevenus = el("ul");
    salaire.contenu.appendChild(ui.formSalaire);
    salaire.contenu.appendChild(el("p", { classe: "note", texte: "Salaires enregistrés :" }));
    salaire.contenu.appendChild(ui.listeRevenus);
    ui.sDate.value = dateDuJour();
    racine.appendChild(salaire.details);

    // ---- Transferts entre enveloppes ----
    const transfert = repliable("🔁 Transférer entre enveloppes");
    ui.formTransfert = el("form");
    ui.tDe = el("select");
    ui.tVers = el("select");
    ui.tMontant = el("input", { type: "number", step: "0.01", min: "0", inputmode: "decimal" });
    ui.tDate = el("input", { type: "date" });
    ui.tNote = el("input", { type: "text" });
    ligneChamp(ui.formTransfert, "perso-t-de", "De l'enveloppe", ui.tDe);
    ligneChamp(ui.formTransfert, "perso-t-vers", "Vers l'enveloppe", ui.tVers);
    ligneChamp(ui.formTransfert, "perso-t-montant", "Montant (€)", ui.tMontant);
    ligneChamp(ui.formTransfert, "perso-t-date", "Date", ui.tDate);
    ligneChamp(ui.formTransfert, "perso-t-note", "Note (facultatif)", ui.tNote);
    ui.formTransfert.appendChild(el("button", { type: "submit", texte: "Transférer" }));
    ui.listeTransferts = el("ul");
    transfert.contenu.appendChild(ui.formTransfert);
    transfert.contenu.appendChild(el("p", { classe: "note", texte: "Derniers transferts :" }));
    transfert.contenu.appendChild(ui.listeTransferts);
    ui.tDate.value = dateDuJour();
    racine.appendChild(transfert.details);

    // ---- Gestion des enveloppes ----
    const gestion = repliable("⚙️ Gérer les enveloppes");
    ui.gestion = el("div");
    ui.formEnv = el("form");
    ui.eNom = el("input", { type: "text" });
    ui.eType = el("select");
    ui.eType.add(new Option("Montant fixe (€)", "fixe"));
    ui.eType.add(new Option("Pourcentage du salaire (%)", "pourcent"));
    ui.eValeur = el("input", { type: "number", step: "0.01", min: "0", inputmode: "decimal" });
    ligneChamp(ui.formEnv, "perso-e-nom", "Nouvelle enveloppe", ui.eNom);
    ligneChamp(ui.formEnv, "perso-e-type", "Règle de répartition", ui.eType);
    ligneChamp(ui.formEnv, "perso-e-valeur", "Valeur (€ ou %)", ui.eValeur);
    ui.formEnv.appendChild(el("button", { type: "submit", texte: "Ajouter l'enveloppe" }));
    gestion.contenu.appendChild(ui.gestion);
    gestion.contenu.appendChild(ui.formEnv);
    racine.appendChild(gestion.details);

    brancherEvenements();
  }

  // ==========================================================================
  // 4) ÉVÉNEMENTS : formulaires et boutons
  // ==========================================================================
  function brancherEvenements() {

    // ---- Dépense perso : ajout ou modification ----
    ui.formDepense.addEventListener("submit", function (event) {
      event.preventDefault();
      const montant = parseFloat(ui.dMontant.value);
      if (isNaN(montant) || montant <= 0) { alert("Entre un montant valide."); return; }
      if (!ui.dEnv.value) { alert("Choisis une enveloppe."); return; }
      if (!ui.dDate.value) { alert("Choisis une date."); return; }

      const depense = {
        date: ui.dDate.value,
        montant: arrondi(montant),
        envId: ui.dEnv.value,
        categorie: ui.dCat.value.trim(),
        note: ui.dNote.value
      };
      // Pas de "await" : hors ligne, la dépense apparaît tout de suite et part au retour du réseau
      if (depenseEnEdition) {
        updateDoc(refDocument("depensesPerso", depenseEnEdition), depense).catch(erreur);
      } else {
        addDoc(refCollection("depensesPerso"), depense).catch(erreur);
      }
      terminerEdition();
    });
    ui.dAnnuler.addEventListener("click", terminerEdition);

    // ---- Changement de période dans la liste ----
    ui.pSelect.addEventListener("change", function () {
      periodeListe = ui.pSelect.value;
      afficherDepenses();
    });

    // ---- Salaire : quand le montant change, on repropose la répartition ----
    ui.sMontant.addEventListener("input", proposer);
    ui.formSalaire.addEventListener("submit", function (event) {
      event.preventDefault();
      const montant = parseFloat(ui.sMontant.value);
      if (isNaN(montant) || montant <= 0) { alert("Entre le montant reçu."); return; }
      if (!ui.sDate.value) { alert("Choisis une date."); return; }

      const repartition = {};
      let somme = 0;
      for (const id in champsRepartition) {
        const valeur = arrondi(parseFloat(champsRepartition[id].value) || 0);
        if (valeur < 0) { alert("Les montants dépassent le salaire : ajuste la répartition."); return; }
        if (valeur > 0) repartition[id] = valeur;
        somme += valeur;
      }
      if (Math.abs(somme - montant) > 0.005) {
        alert("La répartition (" + formatEuro(somme) + ") doit être égale au salaire (" + formatEuro(montant) + ").");
        return;
      }

      addDoc(refCollection("revenus"), {
        date: ui.sDate.value,
        montant: arrondi(montant),
        libelle: ui.sLibelle.value.trim(),
        repartition: repartition        // on garde la répartition choisie : changer les règles plus tard ne la modifie pas
      }).catch(erreur);

      ui.sMontant.value = "";
      ui.sLibelle.value = "";
      ui.sDate.value = dateDuJour();
      proposer();
    });

    // ---- Transfert ----
    ui.formTransfert.addEventListener("submit", function (event) {
      event.preventDefault();
      const montant = parseFloat(ui.tMontant.value);
      if (isNaN(montant) || montant <= 0) { alert("Entre un montant valide."); return; }
      if (ui.tDe.value === ui.tVers.value) { alert("Choisis deux enveloppes différentes."); return; }
      if (!ui.tDate.value) { alert("Choisis une date."); return; }

      addDoc(refCollection("transferts"), {
        date: ui.tDate.value,
        de: ui.tDe.value,
        vers: ui.tVers.value,
        montant: arrondi(montant),
        note: ui.tNote.value.trim()
      }).catch(erreur);
      ui.tMontant.value = "";
      ui.tNote.value = "";
    });

    // ---- Nouvelle enveloppe ----
    ui.formEnv.addEventListener("submit", function (event) {
      event.preventDefault();
      const nom = ui.eNom.value.trim();
      const type = ui.eType.value;
      const valeur = parseFloat(ui.eValeur.value);
      if (nom === "") { alert("Donne un nom à l'enveloppe."); return; }
      if (nomExiste(nom, null)) { alert("Ce nom existe déjà."); return; }
      if (isNaN(valeur) || valeur < 0) { alert("Entre une valeur positive (0 si l'enveloppe ne reçoit rien automatiquement)."); return; }
      if (type === "pourcent" && valeur > 100) { alert("Un pourcentage ne peut pas dépasser 100."); return; }

      // Date.now() donne un nombre unique : on s'en sert pour fabriquer l'identifiant
      const nouvelle = { id: "env-" + Date.now(), nom: nom, type: type, valeur: valeur, parDefaut: false, archivee: false };
      enregistrerEnveloppes(enveloppes.concat([nouvelle]));
      ui.eNom.value = "";
      ui.eValeur.value = "";
    });
  }

  function nomExiste(nom, idIgnore) {
    return enveloppes.some(function (e) {
      return e.id !== idIgnore && e.nom.toLowerCase() === nom.toLowerCase();
    });
  }

  // ---- Modification d'une dépense : on la recharge dans le formulaire ----
  function commencerEdition(d) {
    depenseEnEdition = d.id;
    // Si l'enveloppe est archivée, elle n'est plus dans la liste : on l'y ajoute le temps de la modification
    const existe = Array.from(ui.dEnv.options).some(function (o) { return o.value === d.envId; });
    if (!existe) ui.dEnv.add(new Option(nomEnveloppe(d.envId), d.envId));
    ui.dEnv.value = d.envId;
    ui.dMontant.value = d.montant;
    ui.dDate.value = d.date;
    ui.dCat.value = d.categorie || "";
    ui.dNote.value = d.note || "";
    ui.dValider.textContent = "Enregistrer la modification";
    ui.dAnnuler.hidden = false;
    ui.formDepense.scrollIntoView({ behavior: "smooth" });
  }

  function terminerEdition() {
    depenseEnEdition = null;
    ui.formDepense.reset();
    remplirSelectsEnveloppes();
    ui.dDate.value = dateDuJour();
    ui.dValider.textContent = "Ajouter la dépense";
    ui.dAnnuler.hidden = true;
  }

  // ==========================================================================
  // 5) AFFICHAGES
  // ==========================================================================

  // ---- Aperçu : une ligne par enveloppe avec son solde ----
  function afficherApercu() {
    ui.apercu.innerHTML = "";
    const s = soldes();
    let total = 0;
    for (const e of enveloppes) {
      const solde = s[e.id] || 0;
      if (e.archivee && solde === 0) continue;       // une enveloppe archivée vide n'a plus rien à montrer
      total += solde;
      ui.apercu.appendChild(el("div", { classe: "enveloppe" },
        el("div", { classe: "ligne-cat" },
          el("strong", { texte: e.nom + (e.archivee ? " (archivée)" : "") }),
          el("strong", { classe: solde < 0 ? "negatif" : "", texte: formatEuro(solde) })),
        el("div", { classe: "detail-cat", texte: texteRegle(e) })));
    }
    ui.apercu.appendChild(el("div", { classe: "total-env" },
      el("span", { texte: "Total disponible" }),
      el("strong", { classe: total < 0 ? "negatif" : "", texte: formatEuro(arrondi(total)) })));
    if (revenus.length === 0) {
      ui.apercu.appendChild(el("p", { classe: "note", texte: "Aucun salaire enregistré : ouvre « Enregistrer un salaire » pour remplir tes enveloppes." }));
    }
  }

  // ---- Listes déroulantes d'enveloppes (formulaire de dépense et de transfert) ----
  function remplirSelectsEnveloppes() {
    const defaut = enveloppeParDefaut();
    const precedents = { dEnv: ui.dEnv.value, tDe: ui.tDe.value, tVers: ui.tVers.value };

    for (const cle of ["dEnv", "tDe", "tVers"]) {
      ui[cle].innerHTML = "";
      for (const e of actives()) ui[cle].add(new Option(e.nom, e.id));
      const existe = Array.from(ui[cle].options).some(function (o) { return o.value === precedents[cle]; });
      if (existe) ui[cle].value = precedents[cle];
      else if (cle === "dEnv" && defaut) ui[cle].value = defaut.id;
    }
    // Pour un transfert, on évite de proposer la même enveloppe des deux côtés
    if (ui.tDe.value === ui.tVers.value && ui.tVers.options.length > 1) {
      ui.tVers.selectedIndex = (ui.tVers.selectedIndex + 1) % ui.tVers.options.length;
    }
  }

  // ---- Suggestions de catégories : celles déjà utilisées ----
  function majSuggestions() {
    ui.listeCat.innerHTML = "";
    const vues = new Set();
    for (const d of depenses) {
      if (d.categorie && !vues.has(d.categorie)) {
        vues.add(d.categorie);
        ui.listeCat.appendChild(el("option", { value: d.categorie }));
      }
    }
  }

  // ---- Liste des dépenses perso de la période choisie ----
  function afficherDepenses() {
    const periodes = ctx.periodes();
    ui.pSelect.innerHTML = "";
    for (const p of periodes.slice().reverse()) ui.pSelect.add(new Option(ctx.textePeriode(p), p.debut));

    const courante = periodes.length > 0 ? ctx.periodeDuJour() : null;
    const choisie = periodes.find(function (p) { return p.debut === periodeListe; }) || courante;
    if (choisie) ui.pSelect.value = choisie.debut;

    ui.liste.innerHTML = "";
    const lignes = depenses.filter(function (d) {
      return !choisie || (d.date >= choisie.debut && (choisie.fin === null || d.date <= choisie.fin));
    });

    let total = 0;
    for (const d of lignes) total += d.montant;
    ui.pTotal.textContent = lignes.length > 0 ? "Total de la période : " + formatEuro(arrondi(total)) : "";

    if (lignes.length === 0) {
      vide(ui.liste, "Aucune dépense perso sur cette période.");
      return;
    }

    for (const d of lignes) {
      const li = el("li", null,
        el("div", { classe: "ligne-depense" },
          el("span", { texte: formatDate(d.date) + " – " + nomEnveloppe(d.envId) + (d.categorie ? " – " + d.categorie : "") }),
          el("strong", { texte: formatEuro(d.montant) })));
      if (d.note) li.appendChild(el("div", { classe: "meta", texte: d.note }));

      li.appendChild(el("button", { classe: "petit secondaire", texte: "Modifier", onclick: function () { commencerEdition(d); } }));
      li.appendChild(el("button", {
        classe: "petit danger", texte: "Supprimer",
        onclick: function () {
          if (!confirm("Supprimer cette dépense ?")) return;
          deleteDoc(refDocument("depensesPerso", d.id)).catch(erreur);
        }
      }));
      ui.liste.appendChild(li);
    }
  }

  // ---- Répartition d'un salaire : un champ par enveloppe active ----
  // Les champs ne sont reconstruits que si les enveloppes changent
  // (sinon on effacerait ce que tu es en train de saisir).
  function construireRepartitionSiBesoin() {
    const signature = JSON.stringify(actives().map(function (e) {
      return [e.id, e.nom, e.type, e.valeur, e.parDefaut];
    }));
    if (signature === signatureRepartition) return;
    signatureRepartition = signature;

    ui.repartition.innerHTML = "";
    champsRepartition = {};
    for (const e of actives()) {
      const champ = el("input", { type: "number", step: "0.01", inputmode: "decimal" });
      if (e.parDefaut) champ.readOnly = true;              // le reste est calculé automatiquement
      else champ.addEventListener("input", majReste);
      champsRepartition[e.id] = champ;
      ui.repartition.appendChild(el("label", { texte: e.nom + " (" + texteRegle(e) + ")" }));
      ui.repartition.appendChild(champ);
    }
    proposer();
  }

  // Remplit les champs avec la répartition proposée par les règles
  function proposer() {
    const montant = parseFloat(ui.sMontant.value);
    const proposition = (isNaN(montant) || montant <= 0) ? {} : propositionRepartition(montant);
    for (const id in champsRepartition) {
      champsRepartition[id].value = proposition[id] !== undefined ? proposition[id] : "";
    }
    majReste();
  }

  // L'enveloppe par défaut reçoit toujours le reste : salaire - autres parts
  function majReste() {
    const montant = parseFloat(ui.sMontant.value);
    const defaut = enveloppeParDefaut();
    if (isNaN(montant) || montant <= 0 || !defaut) { ui.sMessage.textContent = ""; return; }

    let autres = 0;
    for (const id in champsRepartition) {
      if (id !== defaut.id) autres += parseFloat(champsRepartition[id].value) || 0;
    }
    const reste = arrondi(montant - autres);
    champsRepartition[defaut.id].value = reste;
    ui.sMessage.textContent = reste < 0
      ? "Les montants dépassent le salaire de " + formatEuro(-reste) + " : ajuste la répartition."
      : "Le reste (" + formatEuro(reste) + ") va dans « " + defaut.nom + " ».";
    ui.sMessage.className = reste < 0 ? "note negatif" : "note";
  }

  // ---- Salaires enregistrés ----
  function afficherRevenus() {
    ui.listeRevenus.innerHTML = "";
    if (revenus.length === 0) { vide(ui.listeRevenus, "Aucun salaire enregistré."); return; }

    for (const r of revenus) {
      const detail = Object.keys(r.repartition || {})
        .filter(function (id) { return r.repartition[id] > 0; })
        .map(function (id) { return nomEnveloppe(id) + " " + formatEuro(r.repartition[id]); })
        .join(" – ");

      ui.listeRevenus.appendChild(el("li", null,
        el("div", { classe: "ligne-depense" },
          el("span", { texte: formatDate(r.date) + " – " + (r.libelle || "Salaire") }),
          el("strong", { texte: formatEuro(r.montant) })),
        el("div", { classe: "meta", texte: detail }),
        el("button", {
          classe: "petit danger", texte: "Supprimer",
          onclick: function () {
            if (!confirm("Supprimer ce salaire ? Les montants versés dans les enveloppes seront retirés.")) return;
            deleteDoc(refDocument("revenus", r.id)).catch(erreur);
          }
        })));
    }
  }

  // ---- Transferts récents ----
  function afficherTransferts() {
    ui.listeTransferts.innerHTML = "";
    if (transferts.length === 0) { vide(ui.listeTransferts, "Aucun transfert."); return; }

    for (const t of transferts.slice(0, 20)) {
      const li = el("li", null,
        el("div", { classe: "ligne-depense" },
          el("span", { texte: formatDate(t.date) + " – " + nomEnveloppe(t.de) + " → " + nomEnveloppe(t.vers) }),
          el("strong", { texte: formatEuro(t.montant) })));
      if (t.note) li.appendChild(el("div", { classe: "meta", texte: t.note }));
      li.appendChild(el("button", {
        classe: "petit danger", texte: "Supprimer",
        onclick: function () {
          if (!confirm("Supprimer ce transfert ?")) return;
          deleteDoc(refDocument("transferts", t.id)).catch(erreur);
        }
      }));
      ui.listeTransferts.appendChild(li);
    }
  }

  // ---- Gestion des enveloppes : renommer, règle, par défaut, archiver ----
  function modifier(id, changements) {
    enregistrerEnveloppes(enveloppes.map(function (e) {
      return e.id === id ? { ...e, ...changements } : e;     // copie de e avec les changements
    }));
  }

  function afficherGestion() {
    ui.gestion.innerHTML = "";
    const s = soldes();

    for (const e of enveloppes) {
      const boutons = [];

      boutons.push(el("button", {
        classe: "petit secondaire", texte: "Renommer",
        onclick: function () {
          const nouveau = (prompt("Nouveau nom :", e.nom) || "").trim();
          if (nouveau === "" || nouveau === e.nom) return;
          if (nomExiste(nouveau, e.id)) { alert("Ce nom existe déjà."); return; }
          modifier(e.id, { nom: nouveau });
        }
      }));

      if (!e.archivee && !e.parDefaut) {
        boutons.push(el("button", {
          classe: "petit secondaire", texte: "Règle",
          onclick: function () {
            const reponse = (prompt("Type de règle : tape % (pourcentage du salaire) ou € (montant fixe)", e.type === "pourcent" ? "%" : "€") || "").trim();
            if (reponse === "") return;
            const type = reponse.startsWith("%") ? "pourcent" : "fixe";
            const saisie = prompt("Valeur (" + (type === "pourcent" ? "%" : "€") + ") :", e.valeur);
            if (saisie === null) return;
            const valeur = parseFloat(String(saisie).replace(",", "."));
            if (isNaN(valeur) || valeur < 0 || (type === "pourcent" && valeur > 100)) { alert("Valeur invalide."); return; }
            modifier(e.id, { type: type, valeur: valeur });
          }
        }));
        boutons.push(el("button", {
          classe: "petit secondaire", texte: "Par défaut",
          onclick: function () {
            // une seule enveloppe par défaut : celle qui reçoit le reste
            enregistrerEnveloppes(enveloppes.map(function (x) { return { ...x, parDefaut: x.id === e.id }; }));
          }
        }));
      }

      if (e.archivee) {
        boutons.push(el("button", { classe: "petit secondaire", texte: "Restaurer", onclick: function () { modifier(e.id, { archivee: false }); } }));
      } else if (!e.parDefaut) {
        boutons.push(el("button", {
          classe: "petit secondaire", texte: "Archiver",
          onclick: function () {
            const solde = s[e.id] || 0;
            if (solde !== 0) {
              alert("Cette enveloppe contient " + formatEuro(solde) + " : transfère d'abord son solde vers une autre enveloppe.");
              return;
            }
            modifier(e.id, { archivee: true });
          }
        }));
      }

      ui.gestion.appendChild(el("div", { classe: "ligne-categorie" },
        el("strong", { texte: e.nom + (e.parDefaut ? " (par défaut)" : "") + (e.archivee ? " (archivée)" : "") }),
        el("div", { classe: "detail-cat", texte: texteRegle(e) + " – solde " + formatEuro(s[e.id] || 0) }),
        ...boutons));
    }
  }

  // ==========================================================================
  // 6) DÉMARRAGE ET ARRÊT
  // ==========================================================================

  // Réaffiche tout ce qui dépend des données
  function rafraichir() {
    if (!uid) return;
    afficherApercu();
    remplirSelectsEnveloppes();
    majSuggestions();
    afficherDepenses();
    construireRepartitionSiBesoin();
    afficherRevenus();
    afficherTransferts();
    afficherGestion();
  }

  // Connexion de l'utilisateur : on écoute ses données en temps réel
  function demarrer(utilisateur) {
    arreter();
    uid = utilisateur.uid;
    const enErreur = function (e) { console.error("Erreur (perso) :", e); };

    arrets.push(onSnapshot(refEnveloppes(), function (snapshot) {
      enveloppes = snapshot.exists() ? snapshot.data().liste : ENVELOPPES_PAR_DEFAUT;
      rafraichir();
    }, enErreur));
    arrets.push(onSnapshot(query(refCollection("revenus"), orderBy("date", "desc")), function (snapshot) {
      revenus = lire(snapshot);
      rafraichir();
    }, enErreur));
    arrets.push(onSnapshot(query(refCollection("depensesPerso"), orderBy("date", "desc")), function (snapshot) {
      depenses = lire(snapshot);
      rafraichir();
    }, enErreur));
    arrets.push(onSnapshot(query(refCollection("transferts"), orderBy("date", "desc")), function (snapshot) {
      transferts = lire(snapshot);
      rafraichir();
    }, enErreur));
  }

  // Déconnexion : on arrête les écoutes et on efface les données en mémoire
  function arreter() {
    for (const arret of arrets) arret();
    arrets = [];
    uid = null;
    enveloppes = ENVELOPPES_PAR_DEFAUT;
    revenus = [];
    depenses = [];
    transferts = [];
    depenseEnEdition = null;
    signatureRepartition = "";
  }

  construireInterface();
  return { demarrer: demarrer, arreter: arreter, rafraichir: rafraichir };
}
