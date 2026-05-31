using System.Net.Http;
using System.Threading.Tasks;

namespace Svc
{
    public class HttpClients
    {
        private readonly HttpClient _http;

        public HttpClients(HttpClient http) { _http = http; }

        // GetAsync — GET /api/users via HttpClient.
        public Task<HttpResponseMessage> ListUsersAsync()
        {
            return _http.GetAsync("/api/users");
        }

        // PostAsJsonAsync — POST /api/orders via HttpClient.
        public Task<HttpResponseMessage> CreateOrderAsync(object body)
        {
            return _http.PostAsJsonAsync("/api/orders", body);
        }

        // DeleteAsync with absolute URL.
        public Task<HttpResponseMessage> DeleteSessionAsync()
        {
            return _http.DeleteAsync("https://auth/api/session");
        }
    }
}
