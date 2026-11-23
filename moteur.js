/**
 * Moteur de règles de participation (article 5.8, règles 1 à 4) — version navigateur.
 * Logique reprise à l'identique de Code.gs (Apps Script) : aucune dépendance à Google.
 *
 * Données attendues (objet d) :
 *   params   : { CLE: valeur, ... }            (Paramètres)
 *   equipes  : [{ equipe, niveau, rang, poule, code }]
 *   rang     : { equipe: rang }
 *   phases   : [{ phase, equipe, journees:[n, n] }]
 *   matchs   : [{ id, date:'AAAA-MM-JJ', equipe, type, phase, journee, statut, ... }]
 *   part     : { 'matchId|licence': { convoque:boolean, entre:boolean } }
 */

export const STATUT = {
  A_VALIDER: 'À valider',
  VALIDE: 'Validé',
  REPORTE: 'Reporté',
  ANNULE: 'Annulé'
};

export const PARAMETRES_DEFAUT = [
  ['REGLE1_ACTIVE', true],
  ['REGLE2_ACTIVE', true],
  ['REGLE3_ACTIVE', true],
  ['REGLE4_ACTIVE', true],
  ['SEUIL_MATCHS_SUP', 10],
  ['MAX_HABITUES', 2],
  ['NON_VALIDEES', 'CONVOQUES'],
  ['PHASE_COURANTE', '1'],
  ['CLUB_FFF', 'LIMOGES FOOTBALL']
];

/* ---------- Dates (AAAA-MM-JJ, en UTC pour éviter les décalages de fuseau) ---------- */

export function ajouterJours(iso, n) {
  const [y, m, j] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, j + n));
  return dt.toISOString().slice(0, 10);
}

export function court(iso) {
  const p = String(iso).split('-');
  return p.length === 3 ? p[2] + '/' + p[1] : String(iso);
}

export function fr(iso) {
  const p = String(iso).split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(iso);
}

const WEEKENDS_ = {};
/** Samedi du week-end de la date (vendredi → samedi suivant, dimanche → samedi précédent). */
export function weekend(iso) {
  if (WEEKENDS_[iso]) return WEEKENDS_[iso];
  const [y, m, j] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, j));
  const jour = dt.getUTCDay(); // 0 = dimanche … 6 = samedi
  const recul = jour === 0 ? 1 : (jour === 6 ? 0 : -(6 - jour));
  dt.setUTCDate(dt.getUTCDate() - recul);
  const r = dt.toISOString().slice(0, 10);
  WEEKENDS_[iso] = r;
  return r;
}

/* ---------- Textes ---------- */

export function sansAccent(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
}

export function cleTexte(s) {
  return sansAccent(s).replace(/\s+/g, ' ');
}

export function vrai(v) {
  if (v === true || v === 1) return true;
  return ['TRUE', 'VRAI', 'OUI', 'X', '1'].indexOf(String(v).trim().toUpperCase()) !== -1;
}

/* ---------- Types et statuts ---------- */

export function typeNormalise(t) {
  const v = sansAccent(t);
  if (v === 'COUPE') return 'Coupe';
  if (v.indexOf('EXEMPT') === 0) return 'Exempt';
  if (v.indexOf('AMICAL') === 0) return 'Amical';
  return 'Championnat';
}

export function typeDepuisTexte(t) {
  const v = sansAccent(t);
  if (/EXEMPT/.test(v)) return 'Exempt';
  if (/TOURNOI|PLATEAU|AMICAL|FESTIVAL|FESTIFOOT|RASSEMBLEMENT|STAGE/.test(v)) return 'Amical';
  if (/COUPE|CHALLENGE/.test(v)) return 'Coupe';
  return 'Championnat';
}

export function statutNormalise(s) {
  const v = sansAccent(s);
  if (v === 'VALIDE') return STATUT.VALIDE;
  if (v === 'REPORTE') return STATUT.REPORTE;
  if (v === 'ANNULE') return STATUT.ANNULE;
  return STATUT.A_VALIDER;
}

/** Rencontre officielle (championnat ou coupe) : la seule qui compte pour les règles. */
export function officiel(m) {
  return m.type === 'Championnat' || m.type === 'Coupe';
}

export function actif(m) {
  return m.statut !== STATUT.REPORTE && m.statut !== STATUT.ANNULE && officiel(m);
}

/* ---------- Paramètres ---------- */

export function regleActive(d, n) {
  const v = d.params['REGLE' + n + '_ACTIVE'];
  return v === undefined || v === '' ? true : vrai(v);
}

export function paramNombre(d, cle, defaut) {
  const v = d.params[cle];
  const n = Number(v);
  return v === undefined || v === '' || isNaN(n) ? defaut : n;
}

/* ---------- Recherches ---------- */

export function trouverMatch(d, matchId) {
  const m = d.matchs.find(x => x.id === String(matchId));
  if (!m) throw new Error('Match introuvable : ' + matchId);
  return m;
}

export function equipeDepuisCode(d, code) {
  const c = String(code || '').trim().toUpperCase();
  const e = d.equipes.find(x => x.code === c || x.equipe.toUpperCase() === c);
  return e ? e.equipe : null;
}

export function indexJoueurs(d) {
  const index = {};
  d.joueurs.forEach(j => {
    index[cleTexte(j.prenom)] = j.licence;
    index[cleTexte(j.licence)] = j.licence;
    if (j.nom) index[cleTexte(j.prenom + ' ' + j.nom)] = j.licence;
  });
  return index;
}

export function superieures(d, equipe) {
  const r = d.rang[equipe];
  return d.equipes.filter(e => e.rang < r).map(e => e.equipe);
}

/* ---------- Fins de phase (règle 2) ---------- */

export function finales(d, phase, equipe) {
  const k = phase + '|' + equipe;
  d.memoFinales = d.memoFinales || {};
  if (!d.memoFinales[k]) d.memoFinales[k] = calculerFinales(d, phase, equipe);
  return d.memoFinales[k];
}

export function calculerFinales(d, phase, equipe) {
  const p = d.phases.find(x => x.phase === phase && x.equipe === equipe);
  if (p && p.journees.length) return p.journees;
  const js = [];
  d.matchs.forEach(m => {
    if (m.equipe === equipe && m.phase === phase && (m.type === 'Championnat' || m.type === 'Exempt') && m.journee &&
        m.statut !== STATUT.ANNULE && js.indexOf(m.journee) === -1) js.push(m.journee);
  });
  js.sort((a, b) => a - b);
  return js.length >= 2 ? js.slice(-2) : [];
}

/* ---------- Présence ---------- */

/** A « joué » pour les règles 1 à 3 : entré en jeu si validé, convoqué sinon (prudent). */
export function aJoue(d, m, lic) {
  const p = d.part[m.id + '|' + lic];
  if (!p) return false;
  if (m.statut === STATUT.VALIDE) return p.entre;
  if (sansAccent(d.params.NON_VALIDEES || 'CONVOQUES') === 'IGNORER') return false;
  return p.convoque || p.entre;
}

export function surFeuille(d, matchId, lic) {
  const p = d.part[matchId + '|' + lic];
  return !!p && (p.convoque || p.entre);
}

/* ---------- Évaluation d'un joueur pour un match ---------- */

export function evaluer(d, cible, lic, ignorer4) {
  const motifs = [];
  const compteurs = {};
  let habitue = false;
  if (!officiel(cible)) return { licence: lic, niveau: 'OK', habitue: false, motifs, compteurs };
  const sup = superieures(d, cible.equipe);
  const seuil = paramNombre(d, 'SEUIL_MATCHS_SUP', 10);

  sup.forEach(S => {
    const passes = d.matchs
      .filter(m => m.equipe === S && actif(m) && m.date < cible.date)
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    // Règle 1 : dernier match de l'équipe supérieure
    if (regleActive(d, 1) && passes.length) {
      const dernier = passes[0];
      if (aJoue(d, dernier, lic)) {
        const lendemain = ajouterJours(cible.date, 1);
        const joueAussi = d.matchs.some(m =>
          m.equipe === S && actif(m) && (m.date === cible.date || m.date === lendemain));
        if (!joueAussi) {
          motifs.push({
            regle: 1, niveau: 'BLOQUE',
            groupe: 'R1 · dernier match éq. ' + S + ' (' + court(dernier.date) + ')',
            message: (dernier.statut === STATUT.VALIDE ? 'A joué' : 'Convoqué (feuille non validée)') +
              ' le ' + fr(dernier.date) + " avec l'équipe " + S +
              " (son dernier match), qui ne joue ni le " + fr(cible.date) + ' ni le lendemain.'
          });
        }
      }
    }

    // Règle 2 : deux dernières journées de la phase
    if (regleActive(d, 2) && cible.type === 'Championnat' && cible.journee) {
      const finCible = finales(d, cible.phase, cible.equipe);
      if (finCible.indexOf(cible.journee) !== -1) {
        const finSup = finales(d, cible.phase, S);
        d.matchs.filter(m =>
          m.equipe === S && actif(m) && m.type === 'Championnat' && m.phase === cible.phase &&
          finSup.indexOf(m.journee) !== -1 && m.date <= cible.date && m.id !== cible.id
        ).forEach(m => {
          if (aJoue(d, m, lic)) {
            motifs.push({
              regle: 2, niveau: 'BLOQUE',
              groupe: 'R2 · J' + m.journee + ' éq. ' + S + ' (fin de phase)',
              message: 'A joué en J' + m.journee + ' (' + fr(m.date) + ") avec l'équipe " + S +
                ", l'une des 2 dernières journées de la phase " + cible.phase + '.'
            });
          }
        });
      }
    }

    // Règle 3 : nombre de matchs avec l'équipe supérieure
    const nb = passes.filter(m => aJoue(d, m, lic)).length;
    compteurs[S] = nb;
    if (regleActive(d, 3) && nb > seuil) {
      habitue = true;
      motifs.push({
        regle: 3, niveau: 'ALERTE',
        groupe: 'R3 · quota (plus de ' + seuil + ' matchs en éq. ' + S + ')',
        message: nb + " matchs avec l'équipe " + S + ' (plus de ' + seuil + ') : compte dans le quota.'
      });
    }
  });

  // Règle 4 : une seule équipe par journée de championnat
  if (regleActive(d, 4) && cible.type === 'Championnat') {
    d.matchs.filter(m =>
      m.id !== cible.id && m.equipe !== cible.equipe && m.type === 'Championnat' && actif(m)
    ).forEach(m => {
      // Art. 8 du règlement U13 : « une même journée de championnat » = même numéro de journée (même phase).
      // La date ne compte pas : un match remis garde sa journée.
      const memeNumero = !!(m.journee && cible.journee && m.phase === cible.phase && m.journee === cible.journee);
      if (!memeNumero || !surFeuille(d, m.id, lic)) return;
      if (ignorer4 && ignorer4[m.id]) return;
      motifs.push({
        regle: 4, niveau: 'BLOQUE',
        groupe: 'R4 · même journée J' + m.journee + ' éq. ' + m.equipe + ' (' + court(m.date) + ')',
        message: "Sur la feuille de l'équipe " + m.equipe + ' en J' + m.journee + ' (' + fr(m.date) +
          ') : même journée de championnat (art. 8 règlement U13).'
      });
    });
  }

  const bloque = motifs.some(m => m.niveau === 'BLOQUE');
  return {
    licence: lic,
    niveau: bloque ? 'BLOQUE' : (motifs.length ? 'ALERTE' : 'OK'),
    habitue,
    motifs,
    compteurs
  };
}
