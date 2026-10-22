using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus
{
    // The filter key cache itself lives in the patcher assembly (it needs Jellyfin's database types and
    // the Harmony serving patches, and the patcher is the side that can reference them). These are the
    // three hooks Jellyfin discovers in a plugin assembly: a hosted service that starts it, a post-scan
    // task that refreshes it at the end of every library scan, and a scheduled task that is the manual
    // backfill. They call across the load-context boundary through PatcherLoader and share no types.

    /// <summary>Registers the services of the filter key cache.</summary>
    public class FilterCacheServiceRegistrator : IPluginServiceRegistrator
    {
        /// <inheritdoc />
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddHostedService<FilterCacheHostedService>();
        }
    }

    /// <summary>Starts the cache once the server's services exist: resolves them, creates the tables, watches the library.</summary>
    public sealed class FilterCacheHostedService : IHostedService
    {
        private readonly IServiceProvider _services;
        private readonly ILogger<FilterCacheHostedService> _logger;

        public FilterCacheHostedService(IServiceProvider services, ILogger<FilterCacheHostedService> logger)
        {
            _services = services;
            _logger = logger;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            // Off the start-up path: table creation takes a database connection, and the cache is an
            // optimisation that must never delay (or fail) the server coming up.
            _ = Task.Run(() => PatcherLoader.FilterCacheStart(_services, _logger), CancellationToken.None);
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            PatcherLoader.FilterCacheStop();
            return Task.CompletedTask;
        }
    }

    /// <summary>Refreshes the libraries that changed, at the end of every library scan.</summary>
    public sealed class FilterCachePostScanTask : ILibraryPostScanTask
    {
        /// <inheritdoc />
        public Task Run(IProgress<double> progress, CancellationToken cancellationToken)
            => PatcherLoader.FilterCacheRebuild(false, progress, cancellationToken);
    }

    /// <summary>Dashboard > Scheduled Tasks > Run: rebuilds the whole cache now (the on-demand backfill).</summary>
    public sealed class FilterCacheRebuildTask : IScheduledTask
    {
        /// <inheritdoc />
        public string Name => "Jellyfin Plus: rebuild filter cache";

        /// <inheritdoc />
        public string Key => "JellyfinPlusFilterCacheRebuild";

        /// <inheritdoc />
        public string Description => "Rebuilds the cached filter lists (tags, genres, years, ratings) that make the library filter panel fast. Runs automatically after each library scan; run it by hand to fill the cache for existing libraries without waiting for a scan.";

        /// <inheritdoc />
        public string Category => "Library";

        /// <inheritdoc />
        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
            => PatcherLoader.FilterCacheRebuild(true, progress, cancellationToken);

        /// <inheritdoc />
        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => Array.Empty<TaskTriggerInfo>();
    }
}
