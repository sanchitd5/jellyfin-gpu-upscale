using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Plus
{
    /// <summary>One chip of a smart category: the tag name to filter by, its display label and its item count.</summary>
    public sealed class SmartTagChip
    {
        /// <summary>Gets or sets the tag name exactly as stored (what a filter sends).</summary>
        [JsonPropertyName("name")]
        public string Name { get; set; }

        /// <summary>Gets or sets the chip label (a prefix family's remainder; otherwise the name).</summary>
        [JsonPropertyName("label")]
        public string Label { get; set; }

        /// <summary>Gets or sets the number of the user's visible items carrying the tag.</summary>
        [JsonPropertyName("count")]
        public int Count { get; set; }
    }

    /// <summary>A category of tags derived from the vocabulary: a prefix family, an exclusive facet or the popular fallback.</summary>
    public sealed class SmartTagCategory
    {
        /// <summary>Gets or sets a stable id (the same vocabulary gives the same id), for per-user hide/rename.</summary>
        [JsonPropertyName("id")]
        public string Id { get; set; }

        /// <summary>Gets or sets the display name.</summary>
        [JsonPropertyName("label")]
        public string Label { get; set; }

        /// <summary>Gets or sets prefix, exclusive or popular.</summary>
        [JsonPropertyName("kind")]
        public string Kind { get; set; }

        /// <summary>Gets or sets the shared prefix (prefix families only; null otherwise).</summary>
        [JsonPropertyName("prefix")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string Prefix { get; set; }

        /// <summary>Gets or sets a value indicating whether this is the primary facet: the exclusive facet covering the most items.</summary>
        [JsonPropertyName("primary")]
        public bool Primary { get; set; }

        /// <summary>Gets or sets the number of visible items carrying at least one of the category's tags.</summary>
        [JsonPropertyName("coverage")]
        public int Coverage { get; set; }

        /// <summary>Gets or sets the chips, count descending.</summary>
        [JsonPropertyName("tags")]
        public List<SmartTagChip> Tags { get; set; } = new List<SmartTagChip>();
    }

    /// <summary>One tag with the (0-based, distinct) indexes of the visible items that carry it.</summary>
    internal sealed class SmartTagRow
    {
        public SmartTagRow(string name, int[] items)
        {
            Name = name;
            Items = items;
        }

        public string Name { get; }

        public int[] Items { get; }

        /// <summary>
        /// Gets or sets where the tag is found in its items' paths: -1 nowhere (an ordinary tag), the folder depth of the
        /// path segment it names, or <see cref="SmartTagCategories.TitleDepth"/> when it is in the item names only.
        /// </summary>
        public int NameDepth { get; set; } = -1;

        /// <summary>Gets a value indicating whether the tag is derived from item names or folders.</summary>
        public bool NameLike => NameDepth >= 0;
    }

    /// <summary>
    /// SMART TAG CATEGORIES, PURE PART: no I/O, deterministic, library-agnostic. Turns a tag vocabulary (each tag with
    /// the visible items that carry it) into a handful of categories. Thresholds and why: see ENHANCEMENTS.md section 3
    /// ("Smart tag categories"); every number below is in <see cref="SmartTagOptions"/>.
    ///
    /// 1. POOL: tags on at least max(3, 0.2% of items), the 800 largest at most, minus name-like tags: a tag found, as
    ///    a whole word sequence, in a folder of the path (or the name) of at least 80% of a sample of its items is
    ///    name-derived at that folder depth. A depth named by more than 12 tags is a list of names (people, series:
    ///    dropped); one named by 12 or fewer is a taxonomy the library is filed by (kept). Title-only tags are dropped.
    /// 2. PREFIX FAMILIES: every pool tag proposes its prefixes of 4 .. len-3 characters; a prefix shared by 3+ pool tags
    ///    is closed to the longest common prefix of its members (so "attrValue" spellings with no separator are found as
    ///    well as "attr: value"), trailing separators trimmed. Kept when the prefix is not itself a pool tag, the members
    ///    rarely stack (items carrying any member / sum of member counts at least 0.5: values of one attribute rather
    ///    than a word stem shared by unrelated tags) and the family covers at least 1% of items. Overlapping families:
    ///    the larger coverage wins.
    /// 3. EXCLUSIVE FACETS: among the remaining pool, two tags are exclusive when the items carrying both are under 2% of
    ///    the smaller tag. From every seed (count order) a set grows greedily by adding, in count order, each tag
    ///    exclusive with all members. A set of 2+ tags covering at least 50% of items, its largest member under 90% of
    ///    that coverage, is a facet; the best covering one is taken, its tags removed, and the search repeats.
    /// 4. POPULAR: the largest remaining pool tags, as the fallback category.
    /// 5. ORDER: prefix families and facets by coverage (ties by id), popular last; at most 8 categories, 30 chips each.
    ///    The exclusive facet with the largest coverage is marked primary.
    /// </summary>
    internal static class SmartTagCategories
    {
        internal const string KindPrefix = "prefix";
        internal const string KindExclusive = "exclusive";
        internal const string KindPopular = "popular";

        private const string Separators = " _-:./|,;";

        /// <summary>The least number of items a tag must carry to take part, for a library of <paramref name="itemCount"/> items.</summary>
        internal static int MinSupport(int itemCount, SmartTagOptions o = null)
        {
            o ??= SmartTagOptions.Default;
            return Math.Max(o.MinSupportItems, (int)Math.Ceiling(o.MinSupportShare * itemCount));
        }

        /// <summary>The <see cref="SmartTagRow.NameDepth"/> of a tag found in item names but not in a folder.</summary>
        internal const int TitleDepth = 1000;

        /// <summary>
        /// Is the tag derived from item names or folders? When the tag's words appear, as a whole word sequence, in a path
        /// segment or the name of at least NameLikeShare of the sampled items: the most common (then shallowest) folder
        /// depth it was found at, or <see cref="TitleDepth"/> when only names carry it. -1 otherwise. Tags under 3
        /// characters never are.
        /// </summary>
        internal static int NameLikeDepth(string tag, IReadOnlyCollection<(string Path, string Name)> samples, SmartTagOptions o = null)
        {
            o ??= SmartTagOptions.Default;
            var needle = Words(tag);
            if (needle.Length < 3 || samples == null || samples.Count == 0)
            {
                return -1;
            }

            needle = " " + needle + " ";
            var depths = new List<int>();
            foreach (var (path, name) in samples)
            {
                // Folders only: the last segment is the file, which says what the item's name says.
                var segs = (path ?? string.Empty).Split('/', '\\');
                var depth = -1;
                for (var d = 0; d < segs.Length - 1 && depth < 0; d++)
                {
                    if ((" " + Words(segs[d]) + " ").Contains(needle, StringComparison.Ordinal))
                    {
                        depth = d;
                    }
                }

                if (depth < 0 && (" " + Words(name) + " " + Words(segs[^1]) + " ").Contains(needle, StringComparison.Ordinal))
                {
                    depth = TitleDepth;
                }

                if (depth >= 0)
                {
                    depths.Add(depth);
                }
            }

            if (depths.Count < o.NameLikeShare * samples.Count)
            {
                return -1;
            }

            return depths.GroupBy(d => d).OrderByDescending(g => g.Count()).ThenBy(g => g.Key).First().Key;
        }

        /// <summary>Lowercase alphanumeric words joined by single spaces.</summary>
        internal static string Words(string s)
        {
            var sb = new StringBuilder((s ?? string.Empty).Length);
            var space = true;
            foreach (var ch in (s ?? string.Empty).ToLowerInvariant())
            {
                if (char.IsLetterOrDigit(ch))
                {
                    sb.Append(ch);
                    space = false;
                }
                else if (!space)
                {
                    sb.Append(' ');
                    space = true;
                }
            }

            return sb.ToString().Trim();
        }

        /// <summary>Builds the categories. <paramref name="itemCount"/> is the number of visible items the rows index into.</summary>
        internal static List<SmartTagCategory> Build(int itemCount, IReadOnlyList<SmartTagRow> rows, SmartTagOptions o = null)
        {
            o ??= SmartTagOptions.Default;
            var result = new List<SmartTagCategory>();
            if (itemCount <= 0 || rows == null || rows.Count == 0)
            {
                return result;
            }

            var minSupport = MinSupport(itemCount, o);
            var supported = rows.Where(r => r != null && !string.IsNullOrWhiteSpace(r.Name) && r.Items != null && r.Items.Length >= minSupport).ToList();

            // A folder level that only a few tags name is a taxonomy the library is organised by (kept); a level that
            // many tags name is a list of names (people, series, uploaders: dropped). Titles are always names.
            var taxonomy = supported
                .Where(r => r.NameDepth >= 0 && r.NameDepth != TitleDepth)
                .GroupBy(r => r.NameDepth)
                .Where(g => g.Count() <= o.TaxonomyMaxValues)
                .Select(g => g.Key)
                .ToHashSet();
            var pool = supported
                .Where(r => r.NameDepth < 0 || taxonomy.Contains(r.NameDepth))
                .OrderByDescending(r => r.Items.Length)
                .ThenBy(r => r.Name, StringComparer.Ordinal)
                .Take(o.MaxPool)
                .ToList();
            if (pool.Count == 0)
            {
                return result;
            }

            var n = pool.Count;
            var lower = pool.Select(r => r.Name.ToLowerInvariant()).ToArray();
            var count = pool.Select(r => r.Items.Length).ToArray();
            var stamp = new int[itemCount];
            var stampId = 0;

            int Union(IEnumerable<int> members)
            {
                stampId++;
                var u = 0;
                foreach (var m in members)
                {
                    foreach (var i in pool[m].Items)
                    {
                        if ((uint)i < (uint)itemCount && stamp[i] != stampId)
                        {
                            stamp[i] = stampId;
                            u++;
                        }
                    }
                }

                return u;
            }

            var used = new bool[n];
            var structured = new List<(SmartTagCategory Cat, int Coverage)>();

            // ---- 2. prefix families ----
            var standalone = new HashSet<string>(lower, StringComparer.Ordinal);
            var byPrefix = new Dictionary<string, List<int>>(StringComparer.Ordinal);
            for (var j = 0; j < n; j++)
            {
                for (var len = o.MinPrefix; len <= lower[j].Length - o.MinRemainder; len++)
                {
                    var p = lower[j].Substring(0, len);
                    if (!byPrefix.TryGetValue(p, out var list))
                    {
                        byPrefix[p] = list = new List<int>();
                    }

                    list.Add(j);
                }
            }

            var closed = new Dictionary<string, int[]>(StringComparer.Ordinal);
            foreach (var kv in byPrefix)
            {
                if (kv.Value.Count < o.MinFamily)
                {
                    continue;
                }

                var lcp = lower[kv.Value[0]];
                foreach (var m in kv.Value)
                {
                    var k = 0;
                    while (k < lcp.Length && k < lower[m].Length && lcp[k] == lower[m][k])
                    {
                        k++;
                    }

                    lcp = lcp.Substring(0, k);
                }

                closed[lcp] = kv.Value.ToArray();
            }

            var families = new List<(string Prefix, int Len, int[] Members, int Coverage)>();
            foreach (var kv in closed)
            {
                var prefix = kv.Key.TrimEnd(Separators.ToCharArray());
                if (prefix.Length < o.MinPrefix || standalone.Contains(prefix) || standalone.Contains(kv.Key))
                {
                    continue;
                }

                var sum = kv.Value.Sum(m => (long)count[m]);
                var union = Union(kv.Value);
                if (union < o.MinCoverageShare * itemCount || union < o.FamilyExclusivity * sum)
                {
                    continue;
                }

                families.Add((prefix, kv.Key.Length, kv.Value, union));
            }

            foreach (var f in families.OrderByDescending(f => f.Coverage).ThenByDescending(f => f.Members.Length).ThenBy(f => f.Prefix, StringComparer.Ordinal))
            {
                if (f.Members.Any(m => used[m]))
                {
                    continue;
                }

                foreach (var m in f.Members)
                {
                    used[m] = true;
                }

                var original = pool[f.Members.OrderByDescending(m => count[m]).ThenBy(m => pool[m].Name, StringComparer.Ordinal).First()].Name;
                var shown = original.Length >= f.Prefix.Length && string.Equals(original.Substring(0, f.Prefix.Length), f.Prefix, StringComparison.OrdinalIgnoreCase)
                    ? original.Substring(0, f.Prefix.Length)
                    : f.Prefix;
                var cat = new SmartTagCategory
                {
                    Id = "prefix:" + Shorten(f.Prefix),
                    Label = Pretty(shown),
                    Kind = KindPrefix,
                    Prefix = shown,
                    Coverage = f.Coverage,
                    Tags = Chips(pool, f.Members, f.Len, o.MaxChips),
                };
                structured.Add((cat, f.Coverage));
            }

            // ---- 3. exclusive facets ----
            var candidates = Enumerable.Range(0, n).Where(j => !used[j]).ToList(); // already count order
            if (candidates.Count >= 2)
            {
                var co = CoOccurrence(itemCount, pool, candidates, out var slot);
                bool Exclusive(int a, int b) => co[(slot[a] * candidates.Count) + slot[b]] < o.ExclusiveRatio * Math.Min(count[a], count[b]);

                for (var round = 0; round < o.MaxExclusive; round++)
                {
                    var free = candidates.Where(j => !used[j]).ToList();
                    (List<int> Set, int Coverage) best = (null, 0);
                    var seen = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var seed in free)
                    {
                        var set = new List<int> { seed };
                        foreach (var v in free)
                        {
                            if (v != seed && set.All(x => Exclusive(v, x)))
                            {
                                set.Add(v);
                            }
                        }

                        if (set.Count < 2 || !seen.Add(string.Join(",", set.OrderBy(x => x))))
                        {
                            continue;
                        }

                        var union = Union(set);
                        if (union > best.Coverage && union >= o.ExclusiveCoverage * itemCount && set.Max(x => count[x]) < o.ExclusiveMaxShare * union)
                        {
                            best = (set, union);
                        }
                    }

                    if (best.Set == null)
                    {
                        break;
                    }

                    foreach (var m in best.Set)
                    {
                        used[m] = true;
                    }

                    var head = best.Set.OrderByDescending(m => count[m]).ThenBy(m => pool[m].Name, StringComparer.Ordinal).ToList();
                    structured.Add((new SmartTagCategory
                    {
                        Id = "exclusive:" + Hash(lower[head[0]]),
                        Kind = KindExclusive,
                        Coverage = best.Coverage,
                        Tags = Chips(pool, head, 0, o.MaxChips),
                    }, best.Coverage));
                }
            }

            var ordered = structured
                .OrderByDescending(s => s.Coverage)
                .ThenBy(s => s.Cat.Id, StringComparer.Ordinal)
                .Select(s => s.Cat)
                .Take(Math.Max(0, o.MaxCategories - 1))
                .ToList();

            // Exclusive facets are named neutrally in coverage order; the user can rename them.
            var letter = 0;
            foreach (var c in ordered.Where(c => c.Kind == KindExclusive))
            {
                c.Label = "Group " + (char)('A' + Math.Min(letter++, 25));
            }

            var primary = ordered.Where(c => c.Kind == KindExclusive).OrderByDescending(c => c.Coverage).FirstOrDefault();
            if (primary != null)
            {
                primary.Primary = true;
            }

            result.AddRange(ordered);

            // ---- 4. popular ----
            var rest = Enumerable.Range(0, n).Where(j => !used[j]).Take(o.MaxChips).ToList();
            if (rest.Count > 0 && result.Count < o.MaxCategories)
            {
                result.Add(new SmartTagCategory
                {
                    Id = KindPopular,
                    Label = "Popular",
                    Kind = KindPopular,
                    Coverage = Union(rest),
                    Tags = Chips(pool, rest, 0, o.MaxChips),
                });
            }

            return result;
        }

        // Pairwise co-occurrence among the candidates, by walking each item's candidate tags once.
        private static int[] CoOccurrence(int itemCount, List<SmartTagRow> pool, List<int> candidates, out Dictionary<int, int> slot)
        {
            var k = candidates.Count;
            slot = new Dictionary<int, int>(k);
            for (var s = 0; s < k; s++)
            {
                slot[candidates[s]] = s;
            }

            var perItem = new List<int>[itemCount];
            for (var s = 0; s < k; s++)
            {
                foreach (var i in pool[candidates[s]].Items)
                {
                    if ((uint)i < (uint)itemCount)
                    {
                        (perItem[i] ??= new List<int>()).Add(s);
                    }
                }
            }

            var co = new int[k * k];
            foreach (var list in perItem)
            {
                if (list == null)
                {
                    continue;
                }

                for (var a = 0; a < list.Count; a++)
                {
                    var row = list[a] * k;
                    for (var b = a + 1; b < list.Count; b++)
                    {
                        co[row + list[b]]++;
                        co[(list[b] * k) + list[a]]++;
                    }
                }
            }

            return co;
        }

        private static List<SmartTagChip> Chips(List<SmartTagRow> pool, IEnumerable<int> members, int prefixLen, int max)
            => members
                .OrderByDescending(m => pool[m].Items.Length)
                .ThenBy(m => pool[m].Name, StringComparer.Ordinal)
                .Take(max)
                .Select(m => new SmartTagChip
                {
                    Name = pool[m].Name,
                    Label = prefixLen > 0 ? Remainder(pool[m].Name, prefixLen) : pool[m].Name,
                    Count = pool[m].Items.Length,
                })
                .ToList();

        /// <summary>The chip label of a family member: what follows the prefix, leading separators removed.</summary>
        internal static string Remainder(string name, int prefixLen)
        {
            if (prefixLen <= 0 || prefixLen >= name.Length)
            {
                return name;
            }

            var rest = name.Substring(prefixLen).TrimStart(Separators.ToCharArray()).Trim();
            return rest.Length == 0 ? name : rest;
        }

        /// <summary>A prefix as a heading: separators trimmed, first letter upper-cased.</summary>
        internal static string Pretty(string prefix)
        {
            var p = (prefix ?? string.Empty).Trim(Separators.ToCharArray()).Trim();
            return p.Length == 0 ? p : char.ToUpper(p[0], CultureInfo.InvariantCulture) + p.Substring(1);
        }

        private static string Shorten(string s) => s.Length <= 60 ? s : s.Substring(0, 60);

        // FNV-1a 64: stable across runs and processes (string.GetHashCode is randomised per process).
        internal static string Hash(string s)
        {
            ulong h = 14695981039346656037UL;
            foreach (var ch in s)
            {
                h ^= ch;
                h *= 1099511628211UL;
            }

            return h.ToString("x16", CultureInfo.InvariantCulture);
        }
    }

    /// <summary>The algorithm's thresholds (see <see cref="SmartTagCategories"/>). Tests override them; the route uses the defaults.</summary>
    internal sealed class SmartTagOptions
    {
        internal static readonly SmartTagOptions Default = new SmartTagOptions();

        public double MinSupportShare { get; set; } = 0.002;

        public int MinSupportItems { get; set; } = 3;

        public int MaxPool { get; set; } = 800;

        public double NameLikeShare { get; set; } = 0.8;

        public int NameLikeSample { get; set; } = 25;

        public int TaxonomyMaxValues { get; set; } = 12;

        public int MinPrefix { get; set; } = 4;

        public int MinRemainder { get; set; } = 3;

        public int MinFamily { get; set; } = 3;

        public double FamilyExclusivity { get; set; } = 0.5;

        public double MinCoverageShare { get; set; } = 0.01;

        public double ExclusiveRatio { get; set; } = 0.02;

        public double ExclusiveCoverage { get; set; } = 0.5;

        public double ExclusiveMaxShare { get; set; } = 0.9;

        public int MaxExclusive { get; set; } = 3;

        public int MaxCategories { get; set; } = 8;

        public int MaxChips { get; set; } = 30;
    }
}
