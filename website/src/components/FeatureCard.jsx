export default function FeatureCard({ icon, title, desc, variant = 'glass', badges = [] }) {
  const cardClass = variant === 'glass' ? 'card-glass' : 'card-solid';

  return (
    <div className={`${cardClass} group`}>
      <span className="material-symbols-outlined text-primary text-3xl md:text-4xl mb-4 md:mb-6">
        {icon}
      </span>
      <h3 className="font-headline text-2xl md:text-3xl font-bold mb-3 md:mb-4 text-on-surface">
        {title}
      </h3>
      <p className="text-on-surface-variant text-base md:text-lg leading-relaxed">
        {desc}
      </p>
      {badges.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-4 md:mt-6">
          {badges.map((badge) => (
            <span key={badge} className="badge">
              {badge}
          </span>
          ))}
        </div>
      )}
    </div>
  );
}