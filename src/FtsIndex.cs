using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus
{
    // The FTS5 trigram search index itself lives in the patcher assembly (FtsIndexEngine: it needs Jellyfin's
    // database types and SearchPatches uses it). These are the hooks Jellyfin discovers in a plugin assembly:
    // a hosted service that starts it, a post-scan task that refreshes it at the end of every library scan,
    // a scheduled task that is the manual backfill, and the admin status routes. The patcher is loaded into the
    // default load context, so its engine is found by name; every call degrades to "off" when the patcher is
    // missing or predates the index (a half-applied deploy), never to an exception.

    internal static class FtsBridge
    {
        private static Type _engine;

        private static Type Engine()
        {
            if (_engine == null)
            {
                var asm = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == "Jellyfin.Plugin.Plus.Patcher");
                _engine = asm?.GetType("Jellyfin.Plugin.Plus.Patcher.FtsIndexEngine");
            }

            return _engine;
        }

        private static object Call(string name, params object[] args)
        {
            var m = Engine()?.GetMethod(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            if (m == null)
            {
                return null;
            }

            try
            {
                return m.Invoke(null, args);
            }
            catch (TargetInvocationException ex)
            {
                throw ex.InnerException ?? ex;
            }
        }

        public static void Start(IServiceProvider services, ILogger logger) => Call("Start", services, logger);

        public static void Stop()
        {
            try
            {
                Call("Stop");
            }
            catch (Exception)
            {
                // shutting down
            }
        }

        public static Task Rebuild(bool force, IProgress<double> progress, CancellationToken ct)
            => Call("RebuildAsync", force, progress, ct) as Task ?? Task.CompletedTask;

        public static bool StartBackground(bool force) => Call("StartBackground", force) is true;

        public static string StatusJson()
            => Call("StatusJson") as string ?? JsonSerializer.Serialize(new { Ready = false, State = "unavailable" });
    }

    /// <summary>Registers the services of the FTS search index.</summary>
    public class FtsIndexServiceRegistrator : IPluginServiceRegistrator
    {
        /// <inheritdoc />
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddHostedService<FtsIndexHostedService>();
        }
    }

    /// <summary>Starts the index once the server's services exist: creates the tables, watches the library.</summary>
    public sealed class FtsIndexHostedService : IHostedService
    {
        private readonly IServiceProvider _services;
        private readonly ILogger<FtsIndexHostedService> _logger;

        public FtsIndexHostedService(IServiceProvider services, ILogger<FtsIndexHostedService> logger)
        {
            _services = services;
            _logger = logger;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            // Off the start-up path: the index is an optimisation that must never delay (or fail) the server coming up.
            _ = Task.Run(
                () =>
                {
                    try
                    {
                        FtsBridge.Start(_services, _logger);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "JellyfinPlus: starting the FTS search index failed; search is unaffected.");
                    }
                },
                CancellationToken.None);
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            FtsBridge.Stop();
            return Task.CompletedTask;
        }
    }

    /// <summary>Refreshes the search index at the end of every library scan (a no-op when it is already true).</summary>
    public sealed class FtsIndexPostScanTask : ILibraryPostScanTask
    {
        /// <inheritdoc />
        public async Task Run(IProgress<double> progress, CancellationToken cancellationToken)
        {
            try
            {
                await FtsBridge.Rebuild(false, progress, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // The index is an optimisation: its failure must not fail the library scan (the engine logs it).
            }
        }
    }

    /// <summary>Dashboard > Scheduled Tasks > Run: rebuilds the whole search index now (the on-demand backfill).</summary>
    public sealed class FtsIndexRebuildTask : IScheduledTask
    {
        /// <inheritdoc />
        public string Name => "Jellyfin Plus: rebuild search index";

        /// <inheritdoc />
        public string Key => "JellyfinPlusFtsIndexRebuild";

        /// <inheritdoc />
        public string Description => "Rebuilds the full-text (trigram) index of item names and tags that speeds up library search. Runs automatically after each library scan and keeps itself fresh as items change; run it by hand to build the index without waiting for a scan. Search falls back to the plain database query whenever the index is missing or out of date.";

        /// <inheritdoc />
        public string Category => "Library";

        /// <inheritdoc />
        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
            => FtsBridge.Rebuild(true, progress, cancellationToken);

        /// <inheritdoc />
        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => Array.Empty<TaskTriggerInfo>();
    }

    /// <summary>Admin routes for the FTS search index.</summary>
    [ApiController]
    [Authorize]
    [Route("JellyfinPlus")]
    public class FtsIndexController : ControllerBase
    {
        /// <summary>State of the index: built at, row counts, size, whether it is usable now, and why not.</summary>
        [HttpGet("FtsIndex/Status")]
        [Authorize(Policy = "RequiresElevation")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public ContentResult GetStatus()
            => new ContentResult { Content = FtsBridge.StatusJson(), ContentType = "application/json", StatusCode = StatusCodes.Status200OK };

        /// <summary>Rebuilds the index in the background and returns at once (202); 409 when a run is in flight or the index is off.</summary>
        /// <param name="force">Rebuild everything, not only when stale. Default true.</param>
        [HttpPost("FtsIndex/Rebuild")]
        [Authorize(Policy = "RequiresElevation")]
        [ProducesResponseType(StatusCodes.Status202Accepted)]
        [ProducesResponseType(StatusCodes.Status409Conflict)]
        public ContentResult Rebuild([FromQuery] bool force = true)
        {
            var started = FtsBridge.StartBackground(force);
            return new ContentResult
            {
                Content = FtsBridge.StatusJson(),
                ContentType = "application/json",
                StatusCode = started ? StatusCodes.Status202Accepted : StatusCodes.Status409Conflict,
            };
        }
    }
}
