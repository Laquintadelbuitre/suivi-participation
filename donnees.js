/**
 * Couche de données de l'outil Participation & qualification U13 (version Firestore).
 * Reprend les fonctions de Code.gs (Apps Script) : mêmes contrôles, mêmes résultats.
 *
 * Le module ne parle pas directement à Firebase. Il reçoit un « magasin » :
 *   magasin.etat()        → { equipes, joueurs, phases, matchs, participations, parametres }   (tableaux d'objets avec `id`)
 *   magasin.appliquer(ops) → applique une liste d'opérations, dans l'ordre :
 *        { op:'set',    col, id, data }     remplace le document
 *        { op:'update', col, id, data }     fusionne des champs
 *        { op:'del',    col, id }           supprime le document
 * La page fournit le magasin Firebase ; les tests fournissent un magasin en mémoire.
 */
import * as M from './moteur.js';

const STATUT = M.STATUT;

/** Paramètres modifiables depuis la page : valeur par défaut, type et description (reprise de Code.gs). */
export const PARAMETRES_DEFAUT = [
  ['REGLE1_ACTIVE', true, "Règle 1 : dernier match de l'équipe supérieure"],
  ['REGLE2_ACTIVE', true, 'Règle 2 : 2 dernières journées de chaque phase (calendrier, ou onglet Phases pour forcer)'],
  ['REGLE3_ACTIVE', true, 'Règle 3 : joueurs ayant plus de N matchs en équipe supérieure'],
  ['REGLE4_ACTIVE', true, 'Règle 4 : une seule équipe par journée de championnat'],
  ['SEUIL_MATCHS_SUP', 10, 'Règle 3 : au-delà de ce nombre de matchs, le joueur compte dans le quota'],
  ['MAX_HABITUES', 2, 'Règle 3 : nombre maximum de ces joueurs sur une feuille de match'],
  ['NON_VALIDEES', 'CONVOQUES', 'Feuilles non validées : CONVOQUES = tous les convoqués comptent (prudent) ; IGNORER = elles ne comptent pas'],
  ['PHASE_COURANTE', '1', "Phase attribuée aux feuilles reçues de l'outil convocation"],
  ['CLUB_FFF', 'LIMOGES FOOTBALL', "Nom de notre club sur epreuves.fff.fr (pour trouver notre composition)"]
];

/* ---------- Utilitaires ---------- */

/** Date du jour à Paris, au format AAAA-MM-JJ. */
export function aujourdhui() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

let compteur = 0;
export function nouvelId() {
  compteur++;
  return 'M' + Date.now().toString(36) + String(compteur).padStart(3, '0') + Math.random().toString(36).slice(2, 6);
}

const estIso = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const normTexte = s => String(s == null ? '' : s).trim();
const fr = M.fr;

/* ---------- Construction de l'objet « d » attendu par le moteur ---------- */

/** Transforme l'état brut (documents Firestore) dans la forme utilisée par le moteur. */
export function construireD(etat) {
  const params = {};
  etat.parametres.forEach(p => { params[p.id] = p.valeur; });

  const equipes = etat.equipes.map(e => ({
    equipe: String(e.id), niveau: e.niveau || '', rang: Number(e.rang), poule: e.poule || '',
    code: normTexte(e.code).toUpperCase()
  }));
  const rang = {};
  equipes.forEach(e => { rang[e.equipe] = e.rang; });

  const phases = etat.phases.map(p => ({
    phase: String(p.phase), equipe: String(p.equipe),
    journees: [Number(p.avant), Number(p.derniere)].filter(n => !isNaN(n) && n > 0)
  }));

  const joueurs = etat.joueurs.map(j => ({
    licence: normTexte(j.licence || j.prenom || j.id),
    licenceReelle: normTexte(j.licence),
    nom: j.nom || '', prenom: j.prenom || '', categorie: j.categorie || '',
    idFFF: normTexte(j.idFFF), actif: j.actif !== false
  })).filter(j => j.licence)
    .sort((a, b) => (a.prenom + ' ' + a.nom).localeCompare(b.prenom + ' ' + b.nom));

  const matchs = etat.matchs.map(m => ({
    id: String(m.id), date: m.date, equipe: String(m.equipe), type: M.typeNormalise(m.type),
    phase: String(m.phase || '1'), journee: Number(m.journee) || null,
    adversaire: m.adversaire || '', lieu: m.lieu || '', heure: m.heure || '',
    statut: M.statutNormalise(m.statut), valideLe: m.valideLe || '', source: m.source || ''
  })).filter(m => m.id && m.date);

  const part = {};
  etat.participations.forEach(p => {
    part[p.matchId + '|' + p.licence] = { convoque: !!p.convoque, entre: !!p.entre };
  });

  return { params, equipes, rang, phases, joueurs, matchs, part };
}

/* ---------- Sorties (formes attendues par la page) ---------- */

function calculerDonnees(d) {
  const today = aujourdhui();
  const matchs = d.matchs.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.equipe.localeCompare(b.equipe);
  });
  const aValider = matchs.filter(m => m.statut === STATUT.A_VALIDER && m.date <= today && M.officiel(m)).map(m => m.id);
  const comptes = {};
  Object.keys(d.part).forEach(k => {
    const id = k.split('|')[0], p = d.part[k];
    const c = comptes[id] || (comptes[id] = { conv: 0, joues: 0 });
    if (p.convoque || p.entre) c.conv++;
    if (p.entre) c.joues++;
  });
  const actifs = d.joueurs.filter(j => j.actif);
  matchs.forEach(m => {
    if (m.statut !== STATUT.VALIDE && M.actif(m)) {
      m.interdits = [];
      m.alertes = [];
      actifs.forEach(j => {
        const ev = M.evaluer(d, m, j.licence);
        const nom = [j.prenom, j.nom].filter(Boolean).join(' ');
        const bl = ev.motifs.filter(x => x.niveau === 'BLOQUE');
        if (bl.length) m.interdits.push({ nom, groupes: bl.map(x => x.groupe) });
        else if (ev.motifs.length) m.alertes.push({ nom, groupes: ev.motifs.map(x => x.groupe) });
      });
    }
    const c = comptes[m.id] || { conv: 0, joues: 0 };
    m.nbConv = c.conv;
    m.nbJoues = c.joues;
    m.finale = m.type === 'Championnat' && !!m.journee && M.finales(d, m.phase, m.equipe).indexOf(m.journee) !== -1;
  });
  return {
    equipes: d.equipes,
    matchs,
    joueurs: d.joueurs.filter(j => j.actif),
    aValider,
    aujourdhui: today,
    clubFFF: String(d.params.CLUB_FFF || 'LIMOGES FOOTBALL'),
    version: 'firestore-1'
  };
}

function calculerFeuille(d, matchId) {
  const cible = M.trouverMatch(d, matchId);
  const lignes = d.joueurs.filter(j => j.actif || d.part[cible.id + '|' + j.licence]).map(j => {
    const p = d.part[cible.id + '|' + j.licence] || { convoque: false, entre: false };
    const ev = M.evaluer(d, cible, j.licence);
    return {
      licence: j.licence, licenceReelle: j.licenceReelle, nom: j.nom, prenom: j.prenom, categorie: j.categorie,
      convoque: p.convoque, entre: p.entre,
      niveau: ev.niveau, habitue: ev.habitue, motifs: ev.motifs, compteurs: ev.compteurs
    };
  });
  return {
    match: cible,
    lignes,
    superieures: M.superieures(d, cible.equipe),
    regle3Active: M.regleActive(d, 3),
    seuil: M.paramNombre(d, 'SEUIL_MATCHS_SUP', 10),
    maxHabitues: M.paramNombre(d, 'MAX_HABITUES', 2)
  };
}

function calculerTableau(d) {
  const rangMax = Math.max.apply(null, d.equipes.map(e => e.rang));
  const equipesSup = d.equipes.filter(e => e.rang < rangMax).map(e => e.equipe);
  const valides = d.matchs.filter(m => m.statut === STATUT.VALIDE);
  const lignes = d.joueurs.filter(j => j.actif).map(j => {
    const parEquipe = {};
    d.equipes.forEach(e => {
      parEquipe[e.equipe] = valides.filter(m => {
        const p = d.part[m.id + '|' + j.licence];
        return m.equipe === e.equipe && p && p.entre;
      }).length;
    });
    return { licence: j.licence, nom: j.nom, prenom: j.prenom, categorie: j.categorie, parEquipe };
  });
  return {
    equipes: d.equipes.map(e => e.equipe),
    equipesSup,
    seuil: M.paramNombre(d, 'SEUIL_MATCHS_SUP', 10),
    nbValidees: valides.length,
    lignes
  };
}

/* ---------- Écritures (opérations sur le magasin) ---------- */

/** Remplace toutes les participations d'un match par `lignes` (convoqués ou entrés en jeu uniquement). */
function opsParticipations(d, matchId, lignes) {
  const ops = [];
  const nouvelles = (lignes || []).filter(l => l.convoque || l.entre);
  const idsNouvelles = new Set(nouvelles.map(l => matchId + '|' + l.licence));
  Object.keys(d.part).forEach(k => {
    if (k.split('|')[0] === String(matchId) && !idsNouvelles.has(k)) {
      ops.push({ op: 'del', col: 'participations', id: k });
    }
  });
  nouvelles.forEach(l => {
    ops.push({
      op: 'set', col: 'participations', id: matchId + '|' + l.licence,
      data: { matchId: String(matchId), licence: String(l.licence), convoque: !!l.convoque || !!l.entre, entre: !!l.entre }
    });
  });
  return ops;
}

/** Champs de la feuille (type, phase, journée) — même règle que majInfosMatch_. */
function opsInfosMatch(matchId, infos) {
  if (!infos) return {};
  const data = {};
  if (infos.type) data.type = M.typeNormalise(infos.type);
  if (infos.phase !== undefined && infos.phase !== '') data.phase = String(infos.phase);
  if (infos.journee !== undefined) data.journee = infos.journee ? Number(infos.journee) : null;
  return data;
}

/* ---------- API (mêmes noms que les fonctions Apps Script appelées par la page) ---------- */

export function creerApi(magasin) {
  const lire = () => construireD(magasin.etat());
  const trouverMatchBrut = (id) => magasin.etat().matchs.find(m => m.id === String(id));
  const appliquer = ops => magasin.appliquer(ops);

  const api = {
    getDonneesInitiales: () => calculerDonnees(lire()),

    getFeuilleMatch: (matchId) => calculerFeuille(lire(), matchId),

    enregistrerFeuille(matchId, lignes, infos) {
      const d = lire();
      const m = M.trouverMatch(d, matchId);
      if (m.statut === STATUT.VALIDE) throw new Error('Feuille validée : cliquez sur « Rouvrir » pour la modifier.');
      if (m.type === 'Exempt') throw new Error("Journée d'exemption : pas de feuille de match.");
      appliquer([{ op: 'update', col: 'matchs', id: String(matchId), data: opsInfosMatch(matchId, infos) }]
        .filter(o => Object.keys(o.data).length)
        .concat(opsParticipations(d, matchId, lignes)));
      return calculerFeuille(lire(), matchId);
    },

    validerFeuille(matchId, lignes, infos) {
      const d = lire();
      const m = M.trouverMatch(d, matchId);
      if (m.statut === STATUT.VALIDE) throw new Error('Cette feuille est déjà validée.');
      if (m.type === 'Exempt') throw new Error("Journée d'exemption : pas de feuille de match.");
      const type = (infos && infos.type) || m.type;
      const journee = infos && infos.journee ? Number(infos.journee) : m.journee;
      if (type === 'Championnat' && !journee) throw new Error('Renseignez la journée de championnat avant de valider.');
      if (!(lignes || []).some(l => l.entre)) {
        throw new Error('Aucun enfant marqué « a joué » : touchez ceux qui ont joué avant de valider.');
      }
      const maj = opsInfosMatch(matchId, infos);
      appliquer([{ op: 'update', col: 'matchs', id: String(matchId),
        data: Object.assign({}, maj, { statut: STATUT.VALIDE, valideLe: new Date().toISOString() }) }]
        .concat(opsParticipations(d, matchId, lignes)));
      return calculerFeuille(lire(), matchId);
    },

    rouvrirFeuille(matchId) {
      appliquer([{ op: 'update', col: 'matchs', id: String(matchId), data: { statut: STATUT.A_VALIDER, valideLe: '' } }]);
      return calculerFeuille(lire(), matchId);
    },

    getTableauJoueurs: () => calculerTableau(lire()),

    getParametres() {
      const v = {};
      magasin.etat().parametres.forEach(p => { v[p.id] = p.valeur; });
      return {
        parametres: PARAMETRES_DEFAUT.map(l => {
          const val = Object.prototype.hasOwnProperty.call(v, l[0]) && v[l[0]] !== '' ? v[l[0]] : l[1];
          return {
            cle: l[0], description: l[2],
            type: typeof l[1] === 'boolean' ? 'bool' : (typeof l[1] === 'number' ? 'nombre' : 'texte'),
            valeur: typeof l[1] === 'boolean' ? M.vrai(val) : (typeof l[1] === 'number' ? Number(val) : String(val))
          };
        }),
        equipes: magasin.etat().equipes.map(e => ({ equipe: String(e.id), niveau: e.niveau || '' })),
        phases: magasin.etat().phases.map(p => ({
          phase: String(p.phase || ''), equipe: String(p.equipe || ''),
          avant: Number(p.avant) || '', derniere: Number(p.derniere) || ''
        }))
      };
    },

    enregistrerParametres(parametres, phases) {
      const ops = [];
      PARAMETRES_DEFAUT.forEach(l => {
        const cle = l[0];
        if (!parametres || !Object.prototype.hasOwnProperty.call(parametres, cle)) return;
        let val = parametres[cle];
        if (typeof l[1] === 'boolean') val = !!val;
        else if (typeof l[1] === 'number') {
          val = Number(val);
          if (isNaN(val) || val < 0) throw new Error('Valeur invalide pour ' + cle);
        } else {
          val = String(val == null ? '' : val).trim();
          if (cle === 'NON_VALIDEES') {
            val = M.sansAccent(val);
            if (['CONVOQUES', 'IGNORER'].indexOf(val) === -1) throw new Error('NON_VALIDEES : CONVOQUES ou IGNORER');
          }
          if (cle === 'PHASE_COURANTE' && !val) throw new Error('La phase courante est obligatoire.');
        }
        ops.push({ op: 'set', col: 'parametres', id: cle, data: { valeur: val } });
      });
      if (Array.isArray(phases)) {
        const propres = [];
        const vues = {};
        phases.forEach(p => {
          const phase = String(p.phase || '').trim();
          const equipe = String(p.equipe || '').trim();
          if (!phase || !equipe) return;
          const a = Number(p.avant) || '', b = Number(p.derniere) || '';
          if (a && b && a >= b) throw new Error('Phase ' + phase + ' / équipe ' + equipe +
            " : l'avant-dernière journée doit précéder la dernière.");
          const k = phase + '|' + equipe;
          if (vues[k]) throw new Error('Phase ' + phase + ' / équipe ' + equipe + ' saisie deux fois.');
          vues[k] = true;
          propres.push({ id: k, data: { phase, equipe, avant: a, derniere: b } });
        });
        magasin.etat().phases.forEach(p => {
          if (!vues[p.id]) ops.push({ op: 'del', col: 'phases', id: p.id });
        });
        propres.forEach(p => ops.push({ op: 'set', col: 'phases', id: p.id, data: p.data }));
      }
      appliquer(ops);
      return api.getParametres();
    },

    importerCalendrier(equipe, lignes) {
      equipe = String(equipe || '');
      const d = lire();
      if (!d.equipes.some(e => e.equipe === equipe)) throw new Error('Équipe inconnue : ' + equipe);
      const phaseDefaut = String(d.params.PHASE_COURANTE || '1') || '1';
      const ops = [];
      const matchsLocaux = d.matchs.slice();
      let crees = 0, maj = 0, ignores = 0;
      (lignes || []).forEach(l => {
        const date = String(l.date || '');
        if (!estIso(date)) { ignores++; return; }
        const infos = {
          adversaire: normTexte(l.adversaire), lieu: normTexte(l.lieu), heure: normTexte(l.heure),
          journee: l.journee ? Number(l.journee) : '', phase: String(l.phase || phaseDefaut), type: M.typeNormalise(l.type)
        };
        const existant = matchsLocaux.find(m => m.equipe === equipe && m.date === date && m.statut !== STATUT.ANNULE);
        if (existant) {
          const valide = existant.statut === STATUT.VALIDE;
          const data = {};
          Object.keys(infos).forEach(k => {
            if (infos[k] === '' || infos[k] === "'") return;
            if (valide && k !== 'adversaire' && k !== 'lieu' && k !== 'heure') return;
            data[k] = infos[k];
          });
          if (Object.keys(data).length) ops.push({ op: 'update', col: 'matchs', id: existant.id, data });
          maj++;
        } else {
          const id = nouvelId();
          const nouveau = {
            id, date, equipe, type: infos.type, phase: infos.phase, journee: infos.journee ? Number(infos.journee) : null,
            adversaire: infos.adversaire, lieu: infos.lieu, heure: infos.heure,
            statut: STATUT.A_VALIDER, valideLe: '', source: 'Calendrier'
          };
          ops.push({ op: 'set', col: 'matchs', id, data: nouveau });
          matchsLocaux.push({ id, equipe, date, statut: STATUT.A_VALIDER });
          crees++;
        }
      });
      appliquer(ops);
      const donnees = api.getDonneesInitiales();
      donnees.import = { crees, maj, ignores };
      return donnees;
    },

    modifierMatch(matchId, i) {
      const d = lire();
      const m = M.trouverMatch(d, matchId);
      if (m.statut === STATUT.VALIDE) throw new Error('Feuille validée : rouvrez-la pour la modifier.');
      i = i || {};
      const data = {};
      if (i.date) {
        if (!estIso(i.date)) throw new Error('Date invalide.');
        const doublon = d.matchs.find(x => x.id !== m.id && x.equipe === m.equipe && x.date === i.date && x.statut !== STATUT.ANNULE);
        if (doublon) throw new Error("L'équipe " + m.equipe + ' a déjà une rencontre le ' + fr(i.date) + '.');
        data.date = i.date;
      }
      ['adversaire', 'lieu', 'heure'].forEach(k => { if (i[k] !== undefined) data[k] = normTexte(i[k]); });
      if (i.type) data.type = M.typeNormalise(i.type);
      if (i.phase !== undefined && i.phase !== '') data.phase = String(i.phase);
      if (i.journee !== undefined) data.journee = i.journee ? Number(i.journee) : null;
      if (i.statut) {
        const st = M.statutNormalise(i.statut);
        if (st === STATUT.VALIDE) throw new Error('Utilisez « Valider » pour valider une feuille.');
        data.statut = st;
      }
      if (Object.keys(data).length) appliquer([{ op: 'update', col: 'matchs', id: String(matchId), data }]);
      return api.getDonneesInitiales();
    },

    supprimerMatch(matchId) {
      const d = lire();
      const m = M.trouverMatch(d, matchId);
      if (m.statut === STATUT.VALIDE) throw new Error('Feuille validée : rouvrez-la avant de la supprimer.');
      appliquer(opsParticipations(d, matchId, []).concat([{ op: 'del', col: 'matchs', id: String(matchId) }]));
      return api.getDonneesInitiales();
    },

    ajouterMatch(m) {
      if (!m || !m.date || !m.equipe) throw new Error("La date et l'équipe sont obligatoires.");
      const d = lire();
      const equipe = String(m.equipe);
      if (!d.equipes.some(e => e.equipe === equipe)) throw new Error('Équipe inconnue : ' + equipe);
      const existant = d.matchs.find(x => x.equipe === equipe && x.date === m.date && x.statut !== STATUT.ANNULE);
      let matchId = existant ? existant.id : '';
      if (!existant) {
        matchId = nouvelId();
        appliquer([{ op: 'set', col: 'matchs', id: matchId, data: {
          id: matchId, date: m.date, equipe, type: M.typeNormalise(m.type),
          phase: String(m.phase || d.params.PHASE_COURANTE || '1') || '1',
          journee: m.journee ? Number(m.journee) : null, adversaire: normTexte(m.adversaire),
          lieu: '', heure: '', statut: STATUT.A_VALIDER, valideLe: '', source: 'Manuel'
        } }]);
      }
      const donnees = api.getDonneesInitiales();
      donnees.nouveauMatch = matchId;
      return donnees;
    },

    ajouterJoueur(j) {
      if (!j || !j.prenom) throw new Error('Le prénom est obligatoire.');
      const id = normTexte(j.licence || j.prenom);
      const d = lire();
      if (d.joueurs.some(x => M.cleTexte(x.licence) === M.cleTexte(id) || M.cleTexte(x.prenom) === M.cleTexte(j.prenom))) {
        throw new Error('Ce joueur existe déjà (même prénom ou même licence).');
      }
      appliquer([{ op: 'set', col: 'joueurs', id, data: {
        licence: normTexte(j.licence), nom: j.nom || '', prenom: normTexte(j.prenom),
        categorie: j.categorie || '', actif: true, idFFF: ''
      } }]);
      return api.getDonneesInitiales();
    },

    /** Applique une feuille FFF : joueurs, rencontre, participations, validation éventuelle. */
    appliquerFeuilleFFF(p) {
      if (!p || !p.equipe || !p.date) throw new Error('Équipe et date obligatoires.');
      const ops = [];
      let d = lire();
      const licences = [];
      (p.joueurs || []).forEach(j => {
        let id = j.licence ? String(j.licence) : '';
        if (!id && j.nouveau && j.nouveau.prenom) {
          let prenom = normTexte(j.nouveau.prenom);
          if (d.joueurs.some(x => M.cleTexte(x.licence) === M.cleTexte(prenom))) {
            prenom = prenom + ' ' + normTexte(j.nouveau.nom);
          }
          ops.push({ op: 'set', col: 'joueurs', id: prenom, data: {
            licence: '', nom: j.nouveau.nom || '', prenom, categorie: '', actif: true, idFFF: j.idFFF || ''
          } });
          d.joueurs.push({ licence: prenom, prenom, actif: true });
          id = prenom;
        } else if (id && j.idFFF) {
          const existant = d.joueurs.find(x => x.licence === id);
          if (existant && existant.idFFF !== j.idFFF) ops.push({ op: 'update', col: 'joueurs', id, data: { idFFF: j.idFFF } });
        }
        if (id && licences.indexOf(id) === -1) licences.push(id);
      });

      let m = p.matchId ? d.matchs.find(x => x.id === p.matchId) : null;
      if (!m) m = d.matchs.find(x => x.equipe === String(p.equipe) && x.date === p.date && x.statut !== STATUT.ANNULE && x.type !== 'Exempt');
      if (m && m.statut === STATUT.VALIDE) throw new Error("La feuille du " + fr(m.date) + ' est déjà validée : rouvrez-la d\'abord.');
      let matchId;
      if (m) {
        matchId = m.id;
        const data = {};
        if (p.journee) data.journee = Number(p.journee);
        if (p.phase) data.phase = String(p.phase);
        if (p.type) data.type = p.type;
        if (!m.adversaire && p.adversaire) data.adversaire = p.adversaire;
        if (!m.lieu && p.domicile !== undefined) data.lieu = p.domicile ? 'Domicile' : 'Extérieur';
        if (m.statut !== STATUT.A_VALIDER) data.statut = STATUT.A_VALIDER;
        if (p.lien) data.lienFFF = p.lien;
        if (Object.keys(data).length) ops.push({ op: 'update', col: 'matchs', id: matchId, data });
      } else {
        matchId = nouvelId();
        ops.push({ op: 'set', col: 'matchs', id: matchId, data: {
          id: matchId, date: p.date, equipe: String(p.equipe), type: p.type || 'Championnat',
          phase: String(p.phase || d.params.PHASE_COURANTE || '1') || '1',
          journee: p.journee ? Number(p.journee) : null, adversaire: p.adversaire || '',
          lieu: p.domicile === undefined ? '' : (p.domicile ? 'Domicile' : 'Extérieur'),
          heure: '', statut: STATUT.A_VALIDER, valideLe: '', source: 'FFF', lienFFF: p.lien || ''
        } });
      }

      // Participations : la composition FFF a joué ; les autres convoqués restent « convoqués »
      const avant = Object.keys(d.part).filter(k => k.split('|')[0] === matchId)
        .map(k => k.split('|')[1]).filter(l => licences.indexOf(l) === -1 && d.part[matchId + '|' + l].convoque);
      ops.push(...opsParticipations(d, matchId, licences.map(l => ({ licence: l, convoque: true, entre: true }))
        .concat(avant.map(l => ({ licence: l, convoque: true, entre: false })))));

      let valide = false;
      if (p.valider) {
        const mm = m ? Object.assign({}, m) : null;
        const typeFinal = (p.type || (mm && mm.type) || 'Championnat');
        const journeeFinale = p.journee ? Number(p.journee) : (mm ? mm.journee : null);
        if (licences.length && (typeFinal !== 'Championnat' || journeeFinale)) {
          ops.push({ op: 'update', col: 'matchs', id: matchId, data: { statut: STATUT.VALIDE, valideLe: new Date().toISOString() } });
          valide = true;
        }
      }
      appliquer(ops);
      const donnees = api.getDonneesInitiales();
      donnees.matchId = matchId;
      donnees.valide = valide;
      return donnees;
    }
  };
  return api;
}

/**
 * Migration unique : convertit la sortie d'exporterTout (Apps Script) en opérations d'écriture.
 * `sortie` = { equipes, joueurs, matchs, part, phases, params } tel que charger_() le renvoie.
 */
export function opsMigration(sortie) {
  const ops = [];
  (sortie.equipes || []).forEach(e => ops.push({ op: 'set', col: 'equipes', id: String(e.equipe), data: {
    niveau: e.niveau || '', rang: Number(e.rang), poule: e.poule || '', code: e.code || '' } }));
  (sortie.joueurs || []).forEach(j => ops.push({ op: 'set', col: 'joueurs', id: String(j.licence), data: {
    licence: j.licenceReelle || '', nom: j.nom || '', prenom: j.prenom || '', categorie: j.categorie || '',
    idFFF: j.idFFF || '', actif: j.actif !== false } }));
  (sortie.matchs || []).forEach(m => ops.push({ op: 'set', col: 'matchs', id: String(m.id), data: {
    id: String(m.id), date: m.date, equipe: m.equipe, type: m.type, phase: m.phase, journee: m.journee || null,
    adversaire: m.adversaire || '', lieu: m.lieu || '', heure: m.heure || '', statut: m.statut,
    valideLe: m.valideLe || '', source: m.source || '' } }));
  Object.keys(sortie.part || {}).forEach(k => {
    const [matchId, licence] = k.split('|');
    const p = sortie.part[k];
    ops.push({ op: 'set', col: 'participations', id: k, data: { matchId, licence, convoque: !!p.convoque, entre: !!p.entre } });
  });
  (sortie.phases || []).forEach(p => ops.push({ op: 'set', col: 'phases', id: p.phase + '|' + p.equipe, data: {
    phase: p.phase, equipe: p.equipe, avant: p.journees[0] || '', derniere: p.journees[1] || '' } }));
  Object.keys(sortie.params || {}).forEach(cle => ops.push({ op: 'set', col: 'parametres', id: cle, data: { valeur: sortie.params[cle] } }));
  return ops;
}
