using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using DbUser = Jellyfin.Database.Implementations.Entities.User;

namespace Jellyfin.Plugin.Plus
{
    /// <summary>Which item kinds exist for a user, with how many items of each.</summary>
    public sealed class LibraryCensus
    {
        /// <summary>Gets or sets the item count per BaseItemKind name; a kind with no items is absent.</summary>
        [JsonPropertyName("counts")]
        public Dictionary<string, int> Counts { get; set; } = new Dictionary<string, int>();
    }

    /// <summary>
    /// "What kinds of item does this user have at all?" - one tiny answer the web client uses to skip search
    /// requests that cannot match anything (Artists with no music, Studios with none, Live TV with none, ...).
    ///
    ///   GET /JellyfinPlus/Library/Census[?userId=..]   ->   { "counts": { "Movie": 1234, "Person": 80, ... } }
    ///
    /// Two kinds of fact go into it. (1) Kinds that live in a library: one grouped count over BaseItems rows
    /// whose TopParentId is a library folder the user can open (the index (Type, TopParentId, Id) covers the
    /// per-type seek; the group is a single pass over those rows). (2) Kinds that do NOT live in a library -
    /// people, studios, genres, artists, playlists, collections, live TV - which have no TopParentId in the
    /// user's libraries: counted library-wide by type (index seeks). Those can overstate what a restricted user
    /// can see (a person credited only on a library the user cannot open still counts), never understate it,
    /// and an overstatement only means a request is sent rather than skipped.
    ///
    /// Cached per user in memory, dropped on ItemAdded / ItemRemoved, with a short TTL as a backstop for changes
    /// that raise no such event. Scoped to the authenticated user; another user's census is for administrators.
    /// </summary>
    [ApiController]
    [Authorize]
    [Route("JellyfinPlus/Library")]
    public class LibraryCensusController : ControllerBase
    {
        private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(5);

        private static readonly ConcurrentDictionary<Guid, (long Gen, DateTime At, LibraryCensus Value)> Cache
            = new ConcurrentDictionary<Guid, (long, DateTime, LibraryCensus)>();

        private static long _generation;
        private static int _subscribed;

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IDbContextFactory<JellyfinDbContext> _dbFactory;

        /// <summary>Initializes a new instance of the <see cref="LibraryCensusController"/> class.</summary>
        public LibraryCensusController(ILibraryManager libraryManager, IUserManager userManager, IDbContextFactory<JellyfinDbContext> dbFactory)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _dbFactory = dbFactory;
            Subscribe(libraryManager);
        }

        /// <summary>Gets the kinds of item the user has, with counts.</summary>
        [HttpGet("Census")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public async Task<ActionResult<LibraryCensus>> GetCensus([FromQuery] Guid? userId, CancellationToken cancellationToken)
        {
            var user = ResolveUser(userId, out var error);
            if (user == null)
            {
                return error;
            }

            var gen = Interlocked.Read(ref _generation);
            if (Cache.TryGetValue(user.Id, out var hit) && hit.Gen == gen && DateTime.UtcNow - hit.At < Ttl)
            {
                return Ok(hit.Value);
            }

            var libs = _libraryManager.GetUserRootFolder().Children
                .OfType<CollectionFolder>()
                .Where(c => c.IsVisible(user))
                .SelectMany(c => c.PhysicalFolderIds)
                .Distinct()
                .ToArray();

            var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
            await using (db.ConfigureAwait(false))
            {
                var value = await LibraryCensusCore.CountAsync(db, libs, cancellationToken).ConfigureAwait(false);
                // Stored under the generation read BEFORE counting: an item added meanwhile bumps it, so this
                // entry is already stale and the next request recounts.
                Cache[user.Id] = (gen, DateTime.UtcNow, value);
                return Ok(value);
            }
        }

        private static void Subscribe(ILibraryManager library)
        {
            if (Interlocked.Exchange(ref _subscribed, 1) == 1)
            {
                return;
            }

            library.ItemAdded += (_, _) => Interlocked.Increment(ref _generation);
            library.ItemRemoved += (_, _) => Interlocked.Increment(ref _generation);
        }

        private DbUser ResolveUser(Guid? requested, out ActionResult error)
        {
            error = null;
            Guid? authenticated = Guid.TryParse(User.FindFirst("Jellyfin-UserId")?.Value, out var a) && a != Guid.Empty ? a : null;
            var admin = User.IsInRole("Administrator");

            Guid id;
            if (!requested.HasValue || requested.Value == Guid.Empty)
            {
                if (!authenticated.HasValue)
                {
                    error = BadRequest("userId is required for this credential.");
                    return null;
                }

                id = authenticated.Value;
            }
            else
            {
                if (requested.Value != authenticated && !admin)
                {
                    error = Forbid();
                    return null;
                }

                id = requested.Value;
            }

            var user = _userManager.GetUserById(id);
            if (user == null)
            {
                error = NotFound();
            }

            return user;
        }
    }

    /// <summary>The database half of the census: no HTTP, no library manager, so it runs on a bare DbContext.</summary>
    internal static class LibraryCensusCore
    {
        // Kinds stored without a TopParentId inside the user's libraries; counted library-wide by type.
        private static readonly string[] ByTypeNames =
        {
            typeof(Person).FullName,
            typeof(Studio).FullName,
            typeof(Genre).FullName,
            typeof(MediaBrowser.Controller.Entities.Audio.MusicGenre).FullName,
            typeof(MediaBrowser.Controller.Entities.Audio.MusicArtist).FullName,
            typeof(MediaBrowser.Controller.Playlists.Playlist).FullName,
            typeof(MediaBrowser.Controller.Entities.Movies.BoxSet).FullName,
            typeof(MediaBrowser.Controller.LiveTv.LiveTvChannel).FullName,
            typeof(MediaBrowser.Controller.LiveTv.LiveTvProgram).FullName,
        };

        internal static async Task<LibraryCensus> CountAsync(JellyfinDbContext db, Guid[] libs, CancellationToken ct)
        {
            var counts = new Dictionary<string, int>(StringComparer.Ordinal);

            if (libs.Length > 0)
            {
                Guid?[] ids = libs.Select(l => (Guid?)l).ToArray();
                var rows = await db.BaseItems.AsNoTracking()
                    .Where(b => EF.Parameter(ids).Contains(b.TopParentId))
                    .GroupBy(b => b.Type)
                    .Select(g => new { Type = g.Key, N = g.Count() })
                    .ToListAsync(ct)
                    .ConfigureAwait(false);
                foreach (var r in rows)
                {
                    Merge(counts, r.Type, r.N);
                }
            }

            foreach (var type in ByTypeNames)
            {
                var t = type;
                var n = await db.BaseItems.AsNoTracking().CountAsync(b => b.Type == t, ct).ConfigureAwait(false);
                if (n > 0)
                {
                    Merge(counts, t, n);
                }
            }

            return new LibraryCensus { Counts = counts };
        }

        /// <summary>BaseItemKind name for a stored CLR type name: its last segment, bar the one class whose name differs from its kind.</summary>
        internal static string KindName(string clrType)
        {
            var dot = clrType.LastIndexOf('.');
            var name = dot < 0 ? clrType : clrType.Substring(dot + 1);
            return name == "LiveTvChannel" ? "TvChannel" : name;
        }

        // Max, not a sum: a kind found both in a library and by type is the same items, counted twice.
        private static void Merge(Dictionary<string, int> counts, string clrType, int n)
        {
            var kind = KindName(clrType);
            counts[kind] = counts.TryGetValue(kind, out var old) ? Math.Max(old, n) : n;
        }
    }
}
