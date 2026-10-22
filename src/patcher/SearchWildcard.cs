using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Jellyfin.Extensions;

namespace Jellyfin.Plugin.Plus.Patcher
{
    /// <summary>What a search term turned out to be.</summary>
    internal enum WildKind
    {
        /// <summary>No wildcard (or too many segments): the term is searched exactly as before.</summary>
        None,

        /// <summary>Wildcards only (or nothing but punctuation between them): treated as no search, i.e. stock behaviour.</summary>
        NoSearch,

        /// <summary>A real wildcard pattern.</summary>
        Pattern,
    }

    /// <summary>
    /// A wildcard search term. In the term, <c>*</c> is any run of characters (none included) and <c>?</c> exactly
    /// one character. Each literal piece between wildcards is cleaned the way item names are stored
    /// (<c>GetCleanValue()</c>: lowercase, diacritics stripped, punctuation to spaces) and the ordered pattern is
    /// matched, unanchored at both ends, with SQL LIKE ... ESCAPE (LIKE, never GLOB: SQLite's GLOB is
    /// case-sensitive). <c>red*car</c> therefore means <c>LIKE '%red%car%'</c>.
    ///
    /// Two renderings of the same term, because the stock name search also tests two columns differently:
    ///   - CleanName and tag CleanValue are already lowercase and diacritic-free, so they are matched with the
    ///     CLEANED literals;
    ///   - OriginalTitle is stored as typed, so, exactly as the stock provider does, it is matched with the
    ///     diacritic-stripped but otherwise uncleaned literals through LIKE, which SQLite evaluates
    ///     case-insensitively for ASCII.
    /// </summary>
    internal sealed class WildPattern
    {
        /// <summary>More literal segments than this and the term is not treated as a wildcard pattern.</summary>
        internal const int MaxSegments = 8;

        /// <summary>The LIKE escape character.</summary>
        internal const string Escape = "\\";

        private WildPattern()
        {
        }

        /// <summary>The cleaned literal segments, in order (never empty strings).</summary>
        public string[] CleanSegments { get; private set; }

        /// <summary>The uncleaned (diacritics-stripped) literal segments, in order, for OriginalTitle.</summary>
        public string[] RawSegments { get; private set; }

        /// <summary>CleanName / tag CleanValue LIKE patterns by score tier (stock: exact 100, prefix 80, word prefix 75, contains 50).</summary>
        public string Exact { get; private set; }

        public string Start { get; private set; }

        public string Word { get; private set; }

        public string Contains { get; private set; }

        /// <summary>OriginalTitle LIKE pattern (contains tier only, as in stock).</summary>
        public string TitleContains { get; private set; }

        /// <summary>
        /// Parses a trimmed, diacritic-stripped search term (what <c>SqlSearchProvider</c> calls
        /// <c>rawSearchTerm</c>). Null unless <paramref name="kind"/> is <see cref="WildKind.Pattern"/>.
        /// </summary>
        public static WildPattern Parse(string raw, out WildKind kind)
        {
            kind = WildKind.None;
            if (string.IsNullOrEmpty(raw) || raw.IndexOfAny(new[] { '*', '?' }) < 0)
            {
                return null;
            }

            // Tokenise into literals and wildcard runs (ones = count of '?', star = any '*').
            var toks = new List<(string Lit, int Ones, bool Star)>();
            var lit = new StringBuilder();
            var ones = 0;
            var star = false;
            void FlushLit()
            {
                if (lit.Length > 0)
                {
                    toks.Add((lit.ToString(), 0, false));
                    lit.Clear();
                }
            }

            void FlushRun()
            {
                if (ones > 0 || star)
                {
                    toks.Add((null, ones, star));
                    ones = 0;
                    star = false;
                }
            }

            foreach (var ch in raw)
            {
                if (ch == '*')
                {
                    FlushLit();
                    star = true;
                }
                else if (ch == '?')
                {
                    FlushLit();
                    ones++;
                }
                else
                {
                    FlushRun();
                    lit.Append(ch);
                }
            }

            FlushLit();
            FlushRun();

            // Cleaned view: a literal that cleans to nothing (only punctuation) disappears, and the wildcard runs
            // either side of it merge into one.
            var clean = Merge(toks.Select(t => t.Lit == null ? t : (CleanOne(t.Lit), 0, false)));
            var rawView = Merge(toks.Select(t => t.Lit == null ? t : (t.Lit, 0, false)));
            var cleanSegs = clean.Where(t => t.Lit != null).Select(t => t.Lit).ToArray();
            if (cleanSegs.Length == 0)
            {
                kind = WildKind.NoSearch;
                return null;
            }

            if (cleanSegs.Length > MaxSegments)
            {
                return null;
            }

            var body = Body(clean);
            kind = WildKind.Pattern;
            return new WildPattern
            {
                CleanSegments = cleanSegs,
                RawSegments = rawView.Where(t => t.Lit != null).Select(t => t.Lit).ToArray(),
                Exact = body,
                Start = body + "%",
                Word = "% " + body + "%",
                Contains = "%" + body + "%",
                TitleContains = "%" + Body(rawView) + "%",
            };
        }

        private static string CleanOne(string lit) => string.IsNullOrWhiteSpace(lit) ? string.Empty : lit.GetCleanValue();

        /// <summary>Drops empty literals and merges neighbouring wildcard runs.</summary>
        private static List<(string Lit, int Ones, bool Star)> Merge(IEnumerable<(string Lit, int Ones, bool Star)> toks)
        {
            var res = new List<(string Lit, int Ones, bool Star)>();
            foreach (var t in toks)
            {
                if (t.Lit != null)
                {
                    if (t.Lit.Length > 0)
                    {
                        res.Add(t);
                    }

                    continue;
                }

                if (res.Count > 0 && res[^1].Lit == null)
                {
                    var p = res[^1];
                    res[^1] = (null, p.Ones + t.Ones, p.Star || t.Star);
                }
                else
                {
                    res.Add(t);
                }
            }

            return res;
        }

        private static string Body(List<(string Lit, int Ones, bool Star)> toks)
        {
            var sb = new StringBuilder();
            foreach (var t in toks)
            {
                if (t.Lit != null)
                {
                    sb.Append(EscapeLike(t.Lit));
                }
                else
                {
                    sb.Append('_', t.Ones);
                    if (t.Star)
                    {
                        sb.Append('%');
                    }
                }
            }

            return sb.ToString();
        }

        /// <summary>Escapes the LIKE wildcards and the escape character in a literal.</summary>
        internal static string EscapeLike(string s)
            => s.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("%", "\\%", StringComparison.Ordinal).Replace("_", "\\_", StringComparison.Ordinal);
    }
}
