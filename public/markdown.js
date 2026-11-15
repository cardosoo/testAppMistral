/* Rendu markdown minimal et sûr, sans dépendance, pour le chat.
 *
 * Principe de sécurité : on échappe d'abord tout le HTML du texte, puis on
 * applique les transformations markdown sur le texte déjà échappé. Les URL
 * des liens/images ne sont autorisées qu'en http(s), mailto: ou relatives
 * (/, #) : aucune injection HTML/JS n'est possible.
 *
 * Supporte : titres #..######, gras **, italique *, code inline ` `,
 * blocs de code ```, listes - / 1., citations >, tableaux |a|b|, hr ---,
 * liens [t](url), images ![alt](url), paragraphes avec <br>.
 */
(function (global) {
  "use strict";

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var URL_OK = /^(https?:\/\/|mailto:|\/|#)/i;

  // Transformations inline, appliquées sur du texte DÉJÀ échappé.
  function mdInline(s) {
    s = s.replace(/`([^`\n]+)`/g, function (m, c) { return "<code>" + c + "</code>"; });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (m, alt, url) {
      return URL_OK.test(url) ? '<img src="' + url + '" alt="' + alt + '" style="max-width:100%">' : alt;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
      return URL_OK.test(url)
        ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + "</a>"
        : text;
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    return s;
  }

  function cells(line) {
    var c = line.trim();
    if (c.charAt(0) === "|") c = c.slice(1);
    if (c.charAt(c.length - 1) === "|") c = c.slice(0, -1);
    return c.split("|").map(function (s) { return s.trim(); });
  }

  function mdToHtml(md) {
    var lines = String(md == null ? "" : md).replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var para = [];
    var i = 0;

    function flushPara() {
      if (para.length) {
        out.push("<p>" + para.map(mdInline).join("<br>") + "</p>");
        para = [];
      }
    }

    while (i < lines.length) {
      var line = lines[i];

      // Bloc de code fence ```
      if (/^```/.test(line.trim())) {
        flushPara();
        var buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // saute la fence fermante
        out.push(
          '<pre style="background:#18181b;color:#e4e4e7;padding:0.6rem;border-radius:0.5rem;overflow-x:auto;font-size:0.78rem"><code>' +
            esc(buf.join("\n")) +
            "</code></pre>"
        );
        continue;
      }

      if (line.trim() === "") { flushPara(); i++; continue; }

      // Titre
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        var lvl = Math.min(h[1].length + 2, 6);
        out.push("<h" + lvl + ' style="margin:0.4rem 0">' + mdInline(esc(h[2])) + "</h" + lvl + ">");
        i++;
        continue;
      }

      // Règle horizontale
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); out.push("<hr>"); i++; continue; }

      // Citation
      if (/^\s*>\s?/.test(line)) {
        flushPara();
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push(
          '<blockquote style="border-left:3px solid #d4d4d8;margin:0.4rem 0;padding:0.2rem 0.8rem;color:#3f3f46">' +
            mdToHtml(q.join("\n")) +
            "</blockquote>"
        );
        continue;
      }

      // Tableau : ligne courante + ligne séparatrice |---|---|
      if (line.indexOf("|") !== -1 && i + 1 < lines.length &&
          /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf("-") !== -1) {
        flushPara();
        var head = cells(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim() !== "") { rows.push(cells(lines[i])); i++; }
        var th = head.map(function (c) {
          return '<th style="border:1px solid #d4d4d8;padding:0.25rem 0.5rem;background:#f4f4f5;text-align:left">' + mdInline(esc(c)) + "</th>";
        }).join("");
        var trs = rows.map(function (r) {
          return "<tr>" + r.map(function (c) {
            return '<td style="border:1px solid #d4d4d8;padding:0.25rem 0.5rem">' + mdInline(esc(c)) + "</td>";
          }).join("") + "</tr>";
        }).join("");
        out.push('<table style="border-collapse:collapse;font-size:0.85rem;margin:0.4rem 0"><thead><tr>' + th + "</tr></thead><tbody>" + trs + "</tbody></table>");
        continue;
      }

      // Liste non ordonnée
      if (/^\s*[-*+]\s+/.test(line)) {
        flushPara();
        var ul = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { ul.push(lines[i].replace(/^\s*[-*+]\s+/, "")); i++; }
        out.push('<ul style="margin:0.3rem 0;padding-left:1.3rem">' + ul.map(function (it) { return "<li>" + mdInline(esc(it)) + "</li>"; }).join("") + "</ul>");
        continue;
      }

      // Liste ordonnée
      if (/^\s*\d+\.\s+/.test(line)) {
        flushPara();
        var ol = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { ol.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
        out.push('<ol style="margin:0.3rem 0;padding-left:1.3rem">' + ol.map(function (it) { return "<li>" + mdInline(esc(it)) + "</li>"; }).join("") + "</ol>");
        continue;
      }

      // Ligne de paragraphe (échappée ici, mise en forme inline au flush)
      para.push(esc(line));
      i++;
    }
    flushPara();
    return out.join("\n");
  }

  global.escHtml = esc;
  global.mdToHtml = mdToHtml;
})(typeof window !== "undefined" ? window : globalThis);
