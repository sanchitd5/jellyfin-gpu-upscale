using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus
{
    /// <summary>Registers the smart tag categories precompute.</summary>
    public class SmartTagPrecomputeRegistrator : IPluginServiceRegistrator
    {
        /// <inheritdoc />
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddHostedService<SmartTagPrecomputeService>();
        }
    }

    /// <summary>One cache entry to keep warm: its key and how to compute it.</summary>
    internal readonly record struct SmartTagWork(string Key, Func<CancellationToken, Task<(List<SmartTagCategory> Cats, long IdsMs)>> Compute);

    /// <summary>
    /// Keeps the smart tag category cache warm (see <see cref="SmartTagsController"/>). About a minute after start,
    /// then every cycle, it computes the entries that are missing or due for every enabled user, for the no-parent
    /// scope and for each library that user can see. Each entry is computed as its own user through the route's
    /// <see cref="SmartTagsCore.ComputeAsync"/> and stored under the route's key (user + access digest + parent),
    /// so an entry is never shared across access digests. One computation at a time, with a pause between them
    /// (the server transcodes on the same box); a cycle is skipped while a library scan runs and bounded by
    /// <see cref="MaxPerCycle"/>.
    /// </summary>
    public sealed class SmartTagPrecomputeService : IHostedService, IDisposable
    {
        internal static readonly TimeSpan StartDelay = TimeSpan.FromSeconds(60);
        internal static readonly TimeSpan CycleEvery = TimeSpan.FromMinutes(1);
        internal static readonly TimeSpan Pause = TimeSpan.FromSeconds(2);
        internal const int MaxPerCycle = 40;

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IDbContextFactory<JellyfinDbContext> _dbFactory;
        private readonly ILogger<SmartTagPrecomputeService> _logger;
        private readonly CancellationTokenSource _stop = new CancellationTokenSource();
        private Task _loop = Task.CompletedTask;
        private int _truncatedLogged;

        public SmartTagPrecomputeService(
            ILibraryManager libraryManager, IUserManager userManager, IDbContextFactory<JellyfinDbContext> dbFactory, ILogger<SmartTagPrecomputeService> logger)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _dbFactory = dbFactory;
            _logger = logger;
        }

        /// <summary>One cycle: warm the entries that are missing or due, serially, paused, bounded. Returns (computed, ms).</summary>
        internal static async Task<(int Computed, long Ms)> RunCycleAsync(
            IEnumerable<SmartTagWork> work, int cap, TimeSpan pause, Func<bool> scanRunning, CancellationToken ct)
        {
            var clock = Stopwatch.StartNew();
            var computed = 0;
            var tried = 0;
            foreach (var w in work)
            {
                ct.ThrowIfCancellationRequested();
                if (SmartTagCache.Lookup(w.Key, SmartTagCache.Generation, out _, out var due) && !due)
                {
                    continue; // warm
                }

                if (tried >= cap || scanRunning())
                {
                    break; // the rest waits for the next cycle
                }

                tried++;
                if (await SmartTagCache.RefreshAsync(w.Key, w.Compute, ct).ConfigureAwait(false))
                {
                    computed++;
                }

                await Task.Delay(pause, ct).ConfigureAwait(false);
            }

            return (computed, clock.ElapsedMilliseconds);
        }

        private IEnumerable<SmartTagWork> Plan()
        {
            Guid[] userIds;
            using (var db = _dbFactory.CreateDbContext())
            {
                userIds = db.Users.AsNoTracking().Select(x => x.Id).ToArray();
            }

            // Capped at the cache size: a larger plan would evict and recompute itself forever. No-parent scope for
            // every user first, then per-library entries until the cap.
            var users = new List<Jellyfin.Database.Implementations.Entities.User>();
            foreach (var userId in userIds)
            {
                var loaded = _userManager.GetUserById(userId); // the manager's loaded user: permissions and preferences included
                if (loaded != null && !loaded.HasPermission(PermissionKind.IsDisabled))
                {
                    users.Add(loaded);
                }
            }

            var count = 0;
            foreach (var u in users)
            {
                if (count++ >= SmartTagCache.MaxEntries)
                {
                    LogTruncated();
                    yield break;
                }

                var user = u;
                yield return new SmartTagWork(SmartTagCache.KeyFor(user, null), ct => SmartTagsCore.ComputeAsync(_libraryManager, _dbFactory, user, null, ct));
            }

            foreach (var u in users)
            {
                var user = u;
                foreach (var lib in _libraryManager.GetUserRootFolder().GetChildren(user, true).OfType<CollectionFolder>().Where(c => c.IsVisible(user)).ToList())
                {
                    if (count++ >= SmartTagCache.MaxEntries)
                    {
                        LogTruncated();
                        yield break;
                    }

                    var l = lib;
                    yield return new SmartTagWork(SmartTagCache.KeyFor(user, l.Id), ct => SmartTagsCore.ComputeAsync(_libraryManager, _dbFactory, user, l, ct));
                }
            }
        }

        private void LogTruncated()
        {
            if (Interlocked.Exchange(ref _truncatedLogged, 1) == 0)
            {
                _logger.LogInformation("JellyfinPlus: smart tag precompute plan truncated to the cache size ({Max} entries).", SmartTagCache.MaxEntries);
            }
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            SmartTagCache.EnsureSubscribed(_libraryManager);
            _loop = Task.Run(() => LoopAsync(_stop.Token), CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            _stop.Cancel();
            try
            {
                await _loop.WaitAsync(TimeSpan.FromSeconds(5), cancellationToken).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // shutting down
            }
        }

        /// <inheritdoc />
        public void Dispose() => _stop.Dispose();

        private async Task LoopAsync(CancellationToken ct)
        {
            try
            {
                await Task.Delay(StartDelay, ct).ConfigureAwait(false);
                while (!ct.IsCancellationRequested)
                {
                    try
                    {
                        if (!_libraryManager.IsScanRunning)
                        {
                            var (computed, ms) = await RunCycleAsync(Plan(), MaxPerCycle, Pause, () => _libraryManager.IsScanRunning, ct).ConfigureAwait(false);
                            if (computed > 0)
                            {
                                _logger.LogInformation("JellyfinPlus: smart tag precompute cycle computed {Computed} entries in {Ms} ms.", computed, ms);
                            }
                        }
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _logger.LogWarning(ex, "JellyfinPlus: smart tag precompute cycle failed; the route computes on demand.");
                    }

                    await Task.Delay(CycleEvery, ct).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // stopping
            }
        }
    }
}
