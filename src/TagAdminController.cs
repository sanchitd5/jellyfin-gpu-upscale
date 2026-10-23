using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus
{
    /// <summary>One tag as stored: an exact spelling, how many items carry it, and its comparison form.</summary>
    public sealed class TagAdminRow
    {
        /// <summary>Gets or sets the tag exactly as stored (case and punctuation as typed).</summary>
        [JsonPropertyName("name")]
        public string Name { get; set; }

        /// <summary>Gets or sets how many items carry exactly this spelling.</summary>
        [JsonPropertyName("count")]
        public int Count { get; set; }

        /// <summary>Gets or sets Jellyfin's cleaned form (lower case, no punctuation); spellings that share it are the same tag to Jellyfin's filters.</summary>
        [JsonPropertyName("clean")]
        public string Clean { get; set; }

        /// <summary>Gets or sets how many stored spellings share <see cref="Clean"/> (2 or more means case or punctuation variants).</summary>
        [JsonPropertyName("variants")]
        public int Variants { get; set; }
    }

    /// <summary>A page of the tag list.</summary>
    public sealed class TagAdminPage
    {
        /// <summary>Gets or sets how many tags matched the query in all.</summary>
        [JsonPropertyName("total")]
        public int Total { get; set; }

        /// <summary>Gets or sets the offset of the first row.</summary>
        [JsonPropertyName("offset")]
        public int Offset { get; set; }

        /// <summary>Gets or sets the rows.</summary>
        [JsonPropertyName("items")]
        public List<TagAdminRow> Items { get; set; } = new List<TagAdminRow>();
    }

    /// <summary>Body of POST /JellyfinPlus/Tags/Edit.</summary>
    public sealed class TagAdminRequest
    {
        /// <summary>Gets or sets the operation: <c>rename</c> (one source), <c>merge</c> (one or more sources into <see cref="To"/>) or <c>delete</c>.</summary>
        [JsonPropertyName("op")]
        public string Op { get; set; }

        /// <summary>Gets or sets the tags to change, as stored (exact spelling).</summary>
        [JsonPropertyName("from")]
        public string[] From { get; set; }

        /// <summary>Gets or sets the new spelling (rename and merge); absent for delete.</summary>
        [JsonPropertyName("to")]
        public string To { get; set; }

        /// <summary>Gets or sets a value indicating whether to only count. Defaults to true: nothing is written unless this is explicitly false.</summary>
        [JsonPropertyName("dryRun")]
        public bool DryRun { get; set; } = true;

        /// <summary>Gets or sets the changedItems the dry run reported; a commit that would now change a different number is refused (409).</summary>
        [JsonPropertyName("expectChanged")]
        public int? ExpectChanged { get; set; }
    }

    /// <summary>Result of a dry run or a commit.</summary>
    public sealed class TagAdminResult
    {
        /// <summary>Gets or sets a value indicating whether this was only a count.</summary>
        [JsonPropertyName("dryRun")]
        public bool DryRun { get; set; }

        /// <summary>Gets or sets a value indicating whether anything was written.</summary>
        [JsonPropertyName("committed")]
        public bool Committed { get; set; }

        /// <summary>Gets or sets the operation.</summary>
        [JsonPropertyName("op")]
        public string Op { get; set; }

        /// <summary>Gets or sets how many items carry any of the source tags.</summary>
        [JsonPropertyName("matchedItems")]
        public int MatchedItems { get; set; }

        /// <summary>Gets or sets how many items have (or, committed, had) their tags changed.</summary>
        [JsonPropertyName("changedItems")]
        public int ChangedItems { get; set; }

        /// <summary>Gets or sets how many matched items were left alone because Tags is in their LockedFields.</summary>
        [JsonPropertyName("lockedSkipped")]
        public int LockedSkipped { get; set; }

        /// <summary>Gets or sets how many matched items could not be loaded (removed meanwhile); commit only.</summary>
        [JsonPropertyName("notLoaded")]
        public int NotLoaded { get; set; }
    }

    /// <summary>
    /// Dashboard tag management: list every tag with its item count, rename, merge and delete across items.
    ///
    ///   GET  /JellyfinPlus/Tags[?q=..][&amp;order=count|name][&amp;limit=100][&amp;offset=0]
    ///   POST /JellyfinPlus/Tags/Edit   { op: rename|merge|delete, from: [..], to: "..", dryRun: true, expectChanged: n }
    ///
    /// ADMINISTRATORS ONLY (RequiresElevation, on the whole controller): it lists tags of every library and
    /// writes to many items, so it is never offered to a normal user and never widened (invariant 13).
    ///
    /// WRITES, in order of care. (1) dryRun defaults to TRUE: a body that forgets the flag only counts. (2) The
    /// affected items are found with plain reads (ItemValues by exact tag, then ItemValuesMap), so a dry run
    /// is exactly the commit's item set. (3) Items whose LockedFields contain Tags are skipped and reported. (4)
    /// The commit may carry expectChanged from the dry run; if the live count differs it is refused with 409
    /// and nothing is written. (5) One edit at a time (409 while another runs). (6) Every item's new tag
    /// array is computed first, then applied and saved in ONE ILibraryManager.UpdateItemsAsync (a single
    /// repository transaction, the metadata-edit path stock's editor uses) - not one save per item; if that
    /// call throws, the in-memory items are restored. (7) At most <see cref="MaxItemsPerEdit"/> items.
    ///
    /// Tags are matched by EXACT spelling (ordinal), the way ItemValues stores them, so "Foo" and "foo" are
    /// two rows the administrator can merge; the Clean column tells variants apart from different tags. An
    /// item that ends up carrying the target twice (case-insensitively) keeps one, spelled as the target.
    /// Series, seasons and albums are edited as items in their own right: stock's editor pushes tag changes
    /// down to children, this does not need to, because every child that carries the tag is itself matched.
    /// </summary>
    [ApiController]
    [Authorize(Policy = "RequiresElevation")]
    [Route("JellyfinPlus/Tags")]
    public class TagAdminController : ControllerBase
    {
        /// <summary>The most items one edit may touch.</summary>
        internal const int MaxItemsPerEdit = 20000;

        private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);
        private static readonly SemaphoreSlim EditLock = new SemaphoreSlim(1, 1);
        private static readonly object ListLock = new object();
        private static (long Gen, DateTime At, List<TagAdminRow> Rows) _list;
        private static long _generation;
        private static int _subscribed;

        private readonly ILibraryManager _libraryManager;
        private readonly IDbContextFactory<JellyfinDbContext> _dbFactory;
        private readonly ILogger<TagAdminController> _logger;

        /// <summary>Initializes a new instance of the <see cref="TagAdminController"/> class.</summary>
        public TagAdminController(ILibraryManager libraryManager, IDbContextFactory<JellyfinDbContext> dbFactory, ILogger<TagAdminController> logger)
        {
            _libraryManager = libraryManager;
            _dbFactory = dbFactory;
            _logger = logger;
            Subscribe(libraryManager);
        }

        /// <summary>Lists the tags with item counts.</summary>
        [HttpGet]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public async Task<ActionResult<TagAdminPage>> List(
            [FromQuery] string q,
            [FromQuery] string order,
            [FromQuery] int? limit,
            [FromQuery] int? offset,
            CancellationToken cancellationToken)
        {
            List<TagAdminRow> rows;
            var gen = Interlocked.Read(ref _generation);
            lock (ListLock)
            {
                rows = _list.Rows != null && _list.Gen == gen && DateTime.UtcNow - _list.At < Ttl ? _list.Rows : null;
            }

            if (rows == null)
            {
                var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
                await using (db.ConfigureAwait(false))
                {
                    rows = await TagAdminCore.ListAsync(db, cancellationToken).ConfigureAwait(false);
                }

                lock (ListLock)
                {
                    _list = (gen, DateTime.UtcNow, rows);
                }
            }

            return Ok(TagAdminCore.Page(rows, q, string.Equals(order, "name", StringComparison.OrdinalIgnoreCase), limit ?? 100, offset ?? 0));
        }

        /// <summary>Counts, or applies, a rename, merge or delete of tags across items.</summary>
        [HttpPost("Edit")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status409Conflict)]
        public async Task<ActionResult<TagAdminResult>> Edit([FromBody] TagAdminRequest request, CancellationToken cancellationToken)
        {
            var problem = TagAdminCore.Validate(request, out var from, out var to);
            if (problem != null)
            {
                return BadRequest(problem);
            }

            if (!await EditLock.WaitAsync(0, cancellationToken).ConfigureAwait(false))
            {
                return Conflict("Another tag edit is running.");
            }

            try
            {
                TagAdminPlan plan;
                var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
                await using (db.ConfigureAwait(false))
                {
                    plan = await TagAdminCore.PlanAsync(db, from, cancellationToken).ConfigureAwait(false);
                }

                var result = new TagAdminResult
                {
                    DryRun = request.DryRun,
                    Op = request.Op,
                    MatchedItems = plan.Matched.Count,
                    LockedSkipped = plan.Locked.Count,
                    ChangedItems = plan.Matched.Count - plan.Locked.Count,
                };

                if (request.DryRun)
                {
                    return Ok(result);
                }

                if (request.ExpectChanged.HasValue && request.ExpectChanged.Value != result.ChangedItems)
                {
                    return Conflict(result);
                }

                if (result.ChangedItems > MaxItemsPerEdit)
                {
                    return BadRequest("This edit would change " + result.ChangedItems.ToString(CultureInfo.InvariantCulture) + " items; the limit is " + MaxItemsPerEdit.ToString(CultureInfo.InvariantCulture) + ".");
                }

                await CommitAsync(plan, from, to, result).ConfigureAwait(false);
                return Ok(result);
            }
            finally
            {
                EditLock.Release();
            }
        }

        private async Task CommitAsync(TagAdminPlan plan, HashSet<string> from, string to, TagAdminResult result)
        {
            // The whole commit ignores the request's cancellation: once items are being changed it finishes or
            // it throws, and a disconnecting browser must not leave half of it saved.
            var changed = new List<BaseItem>();
            var original = new List<string[]>();
            var notLoaded = 0;
            var locked = plan.Locked.Count;
            foreach (var id in plan.Matched)
            {
                if (plan.Locked.Contains(id))
                {
                    continue;
                }

                var item = _libraryManager.GetItemById(id);
                if (item == null)
                {
                    notLoaded++;
                    continue;
                }

                if (item.LockedFields != null && item.LockedFields.Contains(MetadataField.Tags))
                {
                    locked++;
                    continue;
                }

                var before = item.Tags ?? Array.Empty<string>();
                var after = TagAdminCore.Rewrite(before, from, to);
                if (before.SequenceEqual(after, StringComparer.Ordinal))
                {
                    continue;
                }

                original.Add(before);
                item.Tags = after;
                changed.Add(item);
            }

            try
            {
                if (changed.Count > 0)
                {
                    // The shared parent when there is one (what stock passes), otherwise none: the parent is only
                    // reported on the ItemUpdated event, and one call is the point.
                    var parents = changed.Select(i => i.ParentId).Distinct().Take(2).ToList();
                    BaseItem parent = parents.Count == 1 && parents[0] != Guid.Empty ? _libraryManager.GetItemById(parents[0]) : null;
                    await _libraryManager.UpdateItemsAsync(changed, parent, ItemUpdateType.MetadataEdit, CancellationToken.None).ConfigureAwait(false);
                }
            }
            catch
            {
                for (var i = 0; i < changed.Count; i++)
                {
                    changed[i].Tags = original[i];
                }

                throw;
            }

            Interlocked.Increment(ref _generation);
            result.Committed = true;
            result.ChangedItems = changed.Count;
            result.LockedSkipped = locked;
            result.NotLoaded = notLoaded;
            _logger.LogInformation(
                "JellyfinPlus: tag {Op}: {Changed} items changed, {Locked} skipped (locked), {Missing} not loaded",
                result.Op,
                result.ChangedItems,
                result.LockedSkipped,
                result.NotLoaded);
        }

        private static void Subscribe(ILibraryManager library)
        {
            if (Interlocked.Exchange(ref _subscribed, 1) == 1)
            {
                return;
            }

            library.ItemAdded += (_, _) => Interlocked.Increment(ref _generation);
            library.ItemUpdated += (_, _) => Interlocked.Increment(ref _generation);
            library.ItemRemoved += (_, _) => Interlocked.Increment(ref _generation);
        }
    }

    /// <summary>The items an edit touches: every item carrying a source tag, and the subset whose Tags field is locked.</summary>
    internal sealed class TagAdminPlan
    {
        public List<Guid> Matched { get; set; } = new List<Guid>();

        public HashSet<Guid> Locked { get; set; } = new HashSet<Guid>();
    }

    /// <summary>The database and pure halves of tag management: no HTTP, no library manager, so it runs on a bare DbContext.</summary>
    internal static class TagAdminCore
    {
        internal const int MaxNameLength = 200;
        internal const int MaxSources = 100;

        /// <summary>Every stored tag spelling that at least one item carries, with its item count.</summary>
        internal static async Task<List<TagAdminRow>> ListAsync(JellyfinDbContext db, CancellationToken ct)
        {
            var counts = db.ItemValuesMap
                .AsNoTracking()
                .GroupBy(m => m.ItemValueId)
                .Select(g => new { ItemValueId = g.Key, Count = g.Count() });
            var values = db.ItemValues.AsNoTracking().Where(v => v.Type == ItemValueType.Tags);
            var found = await (from c in counts
                               join v in values on c.ItemValueId equals v.ItemValueId
                               select new { v.Value, v.CleanValue, c.Count })
                .ToListAsync(ct)
                .ConfigureAwait(false);

            var variants = found.GroupBy(r => r.CleanValue ?? string.Empty, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
            return found
                .Select(r => new TagAdminRow { Name = r.Value, Count = r.Count, Clean = r.CleanValue, Variants = variants[r.CleanValue ?? string.Empty] })
                .ToList();
        }

        /// <summary>Filters (case-insensitive substring of the name), orders (count descending then name, or name) and pages the list.</summary>
        internal static TagAdminPage Page(List<TagAdminRow> rows, string q, bool byName, int limit, int offset)
        {
            limit = Math.Clamp(limit, 1, 500);
            offset = Math.Max(0, offset);
            IEnumerable<TagAdminRow> sel = rows;
            if (!string.IsNullOrWhiteSpace(q))
            {
                var needle = q.Trim();
                sel = sel.Where(r => r.Name != null && r.Name.Contains(needle, StringComparison.OrdinalIgnoreCase));
            }

            var all = (byName
                ? sel.OrderBy(r => r.Name, StringComparer.Ordinal)
                : sel.OrderByDescending(r => r.Count).ThenBy(r => r.Name, StringComparer.Ordinal)).ToList();
            return new TagAdminPage { Total = all.Count, Offset = offset, Items = all.Skip(offset).Take(limit).ToList() };
        }

        /// <summary>Null when the request is acceptable, otherwise why not. Outputs the normalised sources and target.</summary>
        internal static string Validate(TagAdminRequest r, out HashSet<string> from, out string to)
        {
            from = null;
            to = null;
            if (r == null)
            {
                return "A body is required.";
            }

            var op = (r.Op ?? string.Empty).ToLowerInvariant();
            if (op != "rename" && op != "merge" && op != "delete")
            {
                return "op must be rename, merge or delete.";
            }

            var sources = (r.From ?? Array.Empty<string>()).Where(s => !string.IsNullOrWhiteSpace(s)).Distinct(StringComparer.Ordinal).ToArray();
            if (sources.Length == 0)
            {
                return "from must name at least one tag.";
            }

            if (sources.Length > MaxSources)
            {
                return "At most " + MaxSources.ToString(CultureInfo.InvariantCulture) + " source tags per edit.";
            }

            if (op == "rename" && sources.Length != 1)
            {
                return "rename takes exactly one source tag; use merge for several.";
            }

            if (op == "delete")
            {
                if (r.To != null)
                {
                    return "delete takes no target.";
                }
            }
            else
            {
                to = (r.To ?? string.Empty).Trim();
                if (to.Length == 0)
                {
                    return "to is required.";
                }

                if (to.Length > MaxNameLength)
                {
                    return "to is longer than " + MaxNameLength.ToString(CultureInfo.InvariantCulture) + " characters.";
                }

                // '|' separates the names in a tags= filter, so a name containing it could never be selected again.
                if (to.Contains('|') || to.Any(char.IsControl))
                {
                    return "to may not contain '|' or control characters.";
                }

                if (sources.Length == 1 && string.Equals(sources[0], to, StringComparison.Ordinal))
                {
                    return "to is the same as from; nothing to do.";
                }
            }

            from = new HashSet<string>(sources, StringComparer.Ordinal);
            return null;
        }

        /// <summary>
        /// The tag array after the edit. Tags in <paramref name="from"/> (exact spelling) are replaced by
        /// <paramref name="to"/> (or dropped when null); <paramref name="to"/> appears once, at the position of the
        /// first tag it replaces, and an existing spelling of it that differs only in case becomes the target's
        /// spelling. Every other tag keeps its place and spelling.
        /// </summary>
        internal static string[] Rewrite(string[] tags, HashSet<string> from, string to)
        {
            var result = new List<string>(tags.Length);
            var placed = false;
            foreach (var t in tags)
            {
                if (t == null)
                {
                    continue;
                }

                if (from.Contains(t) || (to != null && string.Equals(t, to, StringComparison.OrdinalIgnoreCase)))
                {
                    if (to != null && !placed)
                    {
                        result.Add(to);
                        placed = true;
                    }
                }
                else
                {
                    result.Add(t);
                }
            }

            return result.ToArray();
        }

        /// <summary>Finds the items carrying any source tag and which of them have Tags locked: plain reads, no writes.</summary>
        internal static async Task<TagAdminPlan> PlanAsync(JellyfinDbContext db, HashSet<string> from, CancellationToken ct)
        {
            var names = from.ToArray();
            var valueIds = await db.ItemValues.AsNoTracking()
                .Where(v => v.Type == ItemValueType.Tags && EF.Parameter(names).Contains(v.Value))
                .Select(v => v.ItemValueId)
                .ToListAsync(ct)
                .ConfigureAwait(false);
            var plan = new TagAdminPlan();
            if (valueIds.Count == 0)
            {
                return plan;
            }

            var vids = valueIds.ToArray();
            plan.Matched = await db.ItemValuesMap.AsNoTracking()
                .Where(m => EF.Parameter(vids).Contains(m.ItemValueId))
                .Select(m => m.ItemId)
                .Distinct()
                .ToListAsync(ct)
                .ConfigureAwait(false);
            if (plan.Matched.Count == 0)
            {
                return plan;
            }

            // Locked: ids carrying the Tags lock. Looked up in chunks so the parameter list stays small.
            var tagsField = (int)MetadataField.Tags;
            foreach (var chunk in plan.Matched.Chunk(900))
            {
                var ids = chunk;
                var locked = await db.BaseItemMetadataFields.AsNoTracking()
                    .Where(f => f.Id == tagsField && EF.Parameter(ids).Contains(f.ItemId))
                    .Select(f => f.ItemId)
                    .ToListAsync(ct)
                    .ConfigureAwait(false);
                plan.Locked.UnionWith(locked);
            }

            return plan;
        }
    }
}
