using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.IO;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus
{
    /// <summary>Body of <c>POST /JellyfinPlus/Ingest</c>.</summary>
    public class IngestRequest
    {
        /// <summary>Gets or sets the absolute path of the new or changed media file.</summary>
        [JsonPropertyName("path")]
        public string Path { get; set; }
    }

    /// <summary>Result of an ingest.</summary>
    public class IngestResult
    {
        /// <summary>Gets or sets the item id of the file, or null when it did not appear.</summary>
        [JsonPropertyName("itemId")]
        public string ItemId { get; set; }

        /// <summary>Gets or sets a value indicating whether this call created the item.</summary>
        [JsonPropertyName("created")]
        public bool Created { get; set; }

        /// <summary>Gets or sets the path of the folder or item that was refreshed.</summary>
        [JsonPropertyName("refreshed")]
        public string Refreshed { get; set; }
    }

    /// <summary>
    /// Adds one file to the library without refreshing the whole model folder. POST
    /// /Library/Media/Updated ends in a recursive ValidateChildren of whichever folder the
    /// FileRefresher settles on (escalating date -> category -> model on sibling paths), which walks
    /// every sub-folder. This validates only the narrowest existing ancestor, one level deep, and
    /// descends one level at a time into the folders that appear.
    /// </summary>
    [ApiController]
    [Authorize]
    [Route("JellyfinPlus")]
    public class IngestController : ControllerBase
    {
        // One ingest at a time: concurrent ValidateChildren on overlapping folders can CreateItems the same
        // deterministic ids. Ingest rate is a few per minute, so correctness beats parallelism.
        private static readonly SemaphoreSlim IngestGate = new SemaphoreSlim(1, 1);
        private static readonly TimeSpan LockTimeout = TimeSpan.FromSeconds(120);

        private readonly ILibraryManager _libraryManager;
        private readonly IProviderManager _providerManager;
        private readonly IFileSystem _fileSystem;
        private readonly ILogger<IngestController> _logger;

        /// <summary>Initializes a new instance of the <see cref="IngestController"/> class.</summary>
        public IngestController(
            ILibraryManager libraryManager,
            IProviderManager providerManager,
            IFileSystem fileSystem,
            ILogger<IngestController> logger)
        {
            _libraryManager = libraryManager;
            _providerManager = providerManager;
            _fileSystem = fileSystem;
            _logger = logger;
        }

        /// <summary>Ingests one file: refreshes its item if known, otherwise adds it via its narrowest existing ancestor folder.</summary>
        /// <param name="request">The file path.</param>
        [HttpPost("Ingest")]
        [Authorize(Policy = "RequiresElevation")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public async Task<ActionResult> Ingest([FromBody] IngestRequest request)
        {
            string path = request?.Path;
            try
            {
                string bad = ValidatePath(path);
                if (bad != null)
                {
                    return BadRequest(new { error = bad });
                }

                if (!System.IO.File.Exists(path))
                {
                    return NotFound(new { error = "file does not exist" });
                }

                if (!await IngestGate.WaitAsync(LockTimeout).ConfigureAwait(false))
                {
                    return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "busy" });
                }

                try
                {
                    BaseItem existing = _libraryManager.FindByPath(path, false);
                    if (existing != null)
                    {
                        return Ok(RefreshExisting(existing));
                    }

                    Folder ancestor = FindNarrowestAncestor(path);
                    if (ancestor == null)
                    {
                        return Conflict(new { error = "no library folder item exists above this path; run a library scan once" });
                    }

                    return Ok(await AddUnderAsync(ancestor, path).ConfigureAwait(false));
                }
                finally
                {
                    IngestGate.Release();
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "JellyfinPlus ingest failed for {Path}", path);
                return StatusCode(StatusCodes.Status500InternalServerError, new { error = ex.Message });
            }
        }

        private string ValidatePath(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || path.IndexOf('\0') >= 0)
            {
                return "path is required";
            }

            if (!System.IO.Path.IsPathRooted(path))
            {
                return "path must be absolute";
            }

            if (!string.Equals(path, System.IO.Path.GetFullPath(path), StringComparison.Ordinal)
                || path.EndsWith(System.IO.Path.DirectorySeparatorChar))
            {
                return "path must be normalised (no '..', '.', duplicate or trailing separators)";
            }

            if (!LibraryRoots().Any(root => IsUnder(root, path)))
            {
                return "path is not inside a library root";
            }

            return null;
        }

        private IEnumerable<string> LibraryRoots()
        {
            return _libraryManager.GetVirtualFolders()
                .SelectMany(f => f.Locations ?? Array.Empty<string>())
                .Where(l => !string.IsNullOrEmpty(l))
                .Select(l => l.TrimEnd(System.IO.Path.DirectorySeparatorChar))
                .Distinct(StringComparer.Ordinal)
                .ToList();
        }

        private static bool IsUnder(string root, string path)
        {
            return path.StartsWith(root + System.IO.Path.DirectorySeparatorChar, StringComparison.Ordinal);
        }

        /// <summary>Walks up from the file's directory to the first directory that already has a Folder item.</summary>
        private Folder FindNarrowestAncestor(string filePath)
        {
            string dir = System.IO.Path.GetDirectoryName(filePath);
            while (!string.IsNullOrEmpty(dir))
            {
                if (_libraryManager.FindByPath(dir, true) is Folder folder)
                {
                    return folder;
                }

                dir = System.IO.Path.GetDirectoryName(dir);
            }

            return null;
        }

        private IngestResult RefreshExisting(BaseItem item)
        {
            var options = new MetadataRefreshOptions(new DirectoryService(_fileSystem));
            _providerManager.QueueRefresh(item.Id, options, RefreshPriority.High);
            _logger.LogInformation("JellyfinPlus ingest: {Path} already in library, queued metadata refresh of the item", item.Path);
            return new IngestResult { ItemId = item.Id.ToString("D"), Created = false, Refreshed = item.Path };
        }

        /// <summary>
        /// Validates <paramref name="start"/> one level deep, then each newly created folder on the way
        /// down to the file's directory. RefreshPaths limits metadata refresh to the new entries only.
        /// </summary>
        private async Task<IngestResult> AddUnderAsync(Folder start, string filePath)
        {
            string fileDir = System.IO.Path.GetDirectoryName(filePath);
            var steps = new List<string>();
            for (string d = fileDir; !string.IsNullOrEmpty(d) && !string.Equals(d, start.Path, StringComparison.Ordinal); d = System.IO.Path.GetDirectoryName(d))
            {
                steps.Insert(0, d);
            }

            Folder current = start;
            for (int i = 0; i <= steps.Count; i++)
            {
                string next = i < steps.Count ? steps[i] : filePath;
                var options = new MetadataRefreshOptions(new DirectoryService(_fileSystem))
                {
                    RefreshPaths = new[] { next },
                };

                _logger.LogInformation("JellyfinPlus ingest: validating children of {Folder} (non-recursive) for {Next}", current.Path, next);
                await current.ValidateChildren(new Progress<double>(), options, recursive: false, allowRemoveRoot: false, CancellationToken.None).ConfigureAwait(false);

                if (i == steps.Count)
                {
                    break;
                }

                current = _libraryManager.FindByPath(next, true) as Folder;
                if (current == null)
                {
                    return new IngestResult { ItemId = null, Created = false, Refreshed = start.Path };
                }
            }

            BaseItem created = _libraryManager.FindByPath(filePath, false);
            return new IngestResult
            {
                ItemId = created?.Id.ToString("D"),
                Created = created != null,
                Refreshed = start.Path,
            };
        }
    }
}
