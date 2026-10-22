using System;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.Plus
{
    /// <summary>Cheap GPU/transcode load snapshot so background encoders can back off while people watch.</summary>
    [ApiController]
    [Authorize]
    [Route("JellyfinPlus")]
    public class GpuLoadController : ControllerBase
    {
        private static readonly object NvencLock = new object();
        private static readonly SemaphoreSlim ProbeGate = new SemaphoreSlim(1, 1);
        private static int? _nvencCached;
        private static DateTime _nvencAtUtc = DateTime.MinValue;

        private readonly ISessionManager _sessions;

        /// <summary>Initializes a new instance of the <see cref="GpuLoadController"/> class.</summary>
        public GpuLoadController(ISessionManager sessions)
        {
            _sessions = sessions;
        }

        /// <summary>Gets active transcodes and NVENC encoder sessions. Any authenticated caller, API key included.</summary>
        [HttpGet("Gpu/Load")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public async Task<ActionResult<GpuLoad>> GetLoad()
        {
            int active = 0, video = 0;
            try
            {
                var transcoding = _sessions.Sessions.Where(s => s.TranscodingInfo != null).ToList();
                active = transcoding.Count;
                video = transcoding.Count(s => !s.TranscodingInfo.IsVideoDirect);
            }
            catch (Exception)
            {
                // counts stay 0
            }

            return new GpuLoad
            {
                ActiveTranscodes = active,
                ActiveVideoTranscodes = video,
                EnhancedSessions = null, // patcher exposes no running-session count, only history
                NvencSessions = await NvencCountAsync().ConfigureAwait(false),
            };
        }

        private static bool TryCached(out int? value)
        {
            lock (NvencLock)
            {
                value = _nvencCached;
                return DateTime.UtcNow - _nvencAtUtc < TimeSpan.FromSeconds(5);
            }
        }

        private static async Task<int?> NvencCountAsync()
        {
            if (TryCached(out var cached))
            {
                return cached;
            }

            // Single-flight: waiters re-check the cache once the running probe (2 s cap) finishes.
            await ProbeGate.WaitAsync().ConfigureAwait(false);
            try
            {
                if (TryCached(out cached))
                {
                    return cached;
                }

                return await ProbeAsync().ConfigureAwait(false);
            }
            finally
            {
                ProbeGate.Release();
            }
        }

        private static async Task<int?> ProbeAsync()
        {
            int? result = null;
            try
            {
                var psi = new ProcessStartInfo("nvidia-smi", "--query-gpu=encoder.stats.sessionCount --format=csv,noheader,nounits")
                {
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using var proc = Process.Start(psi);
                if (proc != null)
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    try
                    {
                        string output = await proc.StandardOutput.ReadToEndAsync(cts.Token).ConfigureAwait(false);
                        await proc.WaitForExitAsync(cts.Token).ConfigureAwait(false);
                        if (proc.ExitCode == 0)
                        {
                            int sum = 0;
                            bool ok = true;
                            foreach (string line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                            {
                                if (int.TryParse(line, NumberStyles.Integer, CultureInfo.InvariantCulture, out int n))
                                {
                                    sum += n;
                                }
                                else
                                {
                                    ok = false;
                                    break;
                                }
                            }

                            if (ok)
                            {
                                result = sum;
                            }
                        }
                    }
                    catch (OperationCanceledException)
                    {
                        try
                        {
                            proc.Kill(true);
                        }
                        catch (Exception)
                        {
                            // already gone
                        }
                    }
                }
            }
            catch (Exception)
            {
                // no nvidia-smi etc: null
            }

            lock (NvencLock)
            {
                _nvencCached = result;
                _nvencAtUtc = DateTime.UtcNow;
            }

            return result;
        }

        /// <summary>Load snapshot.</summary>
        public class GpuLoad
        {
            /// <summary>Gets or sets sessions currently transcoding.</summary>
            [JsonPropertyName("activeTranscodes")]
            public int ActiveTranscodes { get; set; }

            /// <summary>Gets or sets transcodes whose video is being encoded.</summary>
            [JsonPropertyName("activeVideoTranscodes")]
            public int ActiveVideoTranscodes { get; set; }

            /// <summary>Gets or sets running enhancement sessions, null when unknown.</summary>
            [JsonPropertyName("enhancedSessions")]
            public int? EnhancedSessions { get; set; }

            /// <summary>Gets or sets NVENC sessions across GPUs, null when unavailable.</summary>
            [JsonPropertyName("nvencSessions")]
            public int? NvencSessions { get; set; }
        }
    }
}
