using System;
using System.Globalization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.Plus
{
    /// <summary>Status and recent-activity endpoint backing the dashboard page.</summary>
    [ApiController]
    [Authorize]
    [Route("JellyfinPlus")]
    public class UpscaleController : ControllerBase
    {
        /// <summary>Gets the patch status and the recent sessions.</summary>
        [HttpGet("Status")]
        [Authorize(Policy = "RequiresElevation")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public ContentResult GetStatus()
        {
            return new ContentResult
            {
                Content = PatcherLoader.StatusJson(),
                ContentType = "application/json",
                StatusCode = StatusCodes.Status200OK,
            };
        }

        /// <summary>Per-library state of the filter key cache: built at, key counts, whether it is dirty (stale).</summary>
        [HttpGet("FilterCache/Status")]
        [Authorize(Policy = "RequiresElevation")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public ContentResult GetFilterCacheStatus()
        {
            return new ContentResult
            {
                Content = PatcherLoader.FilterCacheStatusJson(),
                ContentType = "application/json",
                StatusCode = StatusCodes.Status200OK,
            };
        }

        /// <summary>
        /// Rebuilds the filter key cache in the background and returns at once (202). Poll
        /// FilterCache/Status for progress. 409 when a rebuild is already running or the cache is off.
        /// </summary>
        /// <param name="force">Rebuild every library, not only the stale ones. Default true.</param>
        [HttpPost("FilterCache/Rebuild")]
        [Authorize(Policy = "RequiresElevation")]
        [ProducesResponseType(StatusCodes.Status202Accepted)]
        [ProducesResponseType(StatusCodes.Status409Conflict)]
        public ContentResult RebuildFilterCache([FromQuery] bool force = true)
        {
            bool started = PatcherLoader.FilterCacheRebuildInBackground(force);
            return new ContentResult
            {
                Content = PatcherLoader.FilterCacheStatusJson(),
                ContentType = "application/json",
                StatusCode = started ? StatusCodes.Status202Accepted : StatusCodes.Status409Conflict,
            };
        }

        /// <summary>
        /// Reports what the server actually did for one play session. Answers for the caller's own
        /// session; for anyone else's it reports unknown rather than leaking that the session
        /// exists, so it is not behind RequiresElevation.
        /// </summary>
        /// <param name="playSessionId">The PlaySessionId of the stream.</param>
        [HttpGet("Session/{playSessionId}")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public ContentResult GetSession([FromRoute] string playSessionId)
        {
            string requestingUserId = null;
            string claim = User.FindFirst("Jellyfin-UserId")?.Value;
            if (!string.IsNullOrEmpty(claim) && Guid.TryParse(claim, out Guid userId))
            {
                requestingUserId = userId.ToString("N", CultureInfo.InvariantCulture);
            }

            return new ContentResult
            {
                Content = PatcherLoader.SessionJson(playSessionId, requestingUserId),
                ContentType = "application/json",
                StatusCode = StatusCodes.Status200OK,
            };
        }
    }
}
