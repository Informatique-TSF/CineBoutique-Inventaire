using System.Linq;
using CineBoutique.Inventory.Api.Infrastructure.Audit;
using CineBoutique.Inventory.Api.Tests.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using System.Net.Http.Headers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace CineBoutique.Inventory.Api.Tests.Infrastructure;

public sealed class InventoryApiFactory : WebApplicationFactory<Program>
{
    private readonly string _connectionString;
    private readonly bool _useTestAuditLogger;

    public InventoryApiFactory(string connectionString, bool useTestAuditLogger = true)
    {
        _connectionString = connectionString ?? throw new ArgumentNullException(nameof(connectionString));
        _useTestAuditLogger = useTestAuditLogger;
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);

        builder.UseEnvironment("Testing");

        builder.ConfigureAppConfiguration((_, configurationBuilder) =>
        {
            var overrides = new Dictionary<string, string?>
            {
                ["ConnectionStrings:Default"] = _connectionString,
                ["DISABLE_SERILOG"] = "true",
                ["APPLY_MIGRATIONS"] = "false",
                ["DISABLE_MIGRATIONS"] = "false",
                ["RunMigrationsOnStart"] = "false",
                ["AppSettings:SeedOnStartup"] = "false",
                // L'opérateur par défaut des tests est fictif : le contrôle « admin réel » est activé par les tests dédiés.
                ["Authorization:VerifyShopAdmin"] = "false"
            };
            configurationBuilder.AddInMemoryCollection(overrides!);
        });

        // >>> clé: on remplace les services DB pour stopper 127.0.0.1
        builder.ConfigureServices(services =>
        {
            var doomed = services.Where(d =>
                    d.ServiceType == typeof(NpgsqlDataSource) ||
                    d.ServiceType == typeof(NpgsqlConnection))
                .ToList();

            foreach (var d in doomed)
                services.Remove(d);

            services.AddSingleton(_ => NpgsqlDataSource.Create(_connectionString));
            services.AddScoped(sp => sp.GetRequiredService<NpgsqlDataSource>().CreateConnection());

            if (_useTestAuditLogger)
            {
                var auditDescriptors = services
                    .Where(descriptor => descriptor.ServiceType == typeof(IAuditLogger))
                    .ToList();

                foreach (var descriptor in auditDescriptors)
                {
                    services.Remove(descriptor);
                }

                services.AddSingleton<TestAuditLogger>();
                services.AddSingleton<IAuditLogger>(sp => sp.GetRequiredService<TestAuditLogger>());
            }
        });
    }


    protected override void ConfigureClient(HttpClient client)
    {
        ArgumentNullException.ThrowIfNull(client);

        client.BaseAddress ??= new Uri("http://localhost");
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        const string defaultOperatorId = "11111111-1111-1111-1111-111111111111";
        const string defaultOperatorName = "Integration Test Operator";

        if (!client.DefaultRequestHeaders.Contains("X-Operator-Id"))
        {
            client.DefaultRequestHeaders.Add("X-Operator-Id", defaultOperatorId);
        }

        if (!client.DefaultRequestHeaders.Contains("X-Operator-Name"))
        {
            client.DefaultRequestHeaders.Add("X-Operator-Name", defaultOperatorName);
        }

        if (!client.DefaultRequestHeaders.Contains("X-Admin"))
        {
            client.DefaultRequestHeaders.Add("X-Admin", "true");
        }
    }
}
